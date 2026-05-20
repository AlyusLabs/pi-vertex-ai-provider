import { execFileSync } from "node:child_process";
import { getModels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "google-vertex";
const ADC_API_KEY_MARKER = "gcp-vertex-credentials";
const DEFAULT_LOCATION = "global";
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";

const GEMINI_3_5_FLASH: ProviderModelConfig = {
	id: "gemini-3.5-flash",
	name: "Gemini 3.5 Flash (Vertex)",
	api: "google-vertex",
	baseUrl: VERTEX_BASE_URL,
	reasoning: true,
	thinkingLevelMap: { off: null },
	input: ["text", "image"],
	cost: {
		// Vertex AI base tier pricing. Pi's model schema has one flat rate, so this
		// intentionally does not model the higher >128K-token tier separately.
		input: 1.5,
		output: 9,
		cacheRead: 0.15,
		cacheWrite: 0,
	},
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function gcloudConfigValue(property: string): string | undefined {
	try {
		const output = execFileSync("gcloud", ["config", "get-value", property], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const value = output.trim();
		return value && value !== "(unset)" ? value : undefined;
	} catch {
		return undefined;
	}
}

function getVertexModels(): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = getModels("google-vertex").map(
		({ id, name, api, baseUrl, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens, headers }) => ({
			id,
			name,
			api,
			baseUrl,
			reasoning,
			thinkingLevelMap,
			input: [...input],
			cost: { ...cost },
			contextWindow,
			maxTokens,
			...(headers && { headers }),
		}),
	);

	const byId = new Map(models.map((model) => [model.id, model]));
	byId.set(GEMINI_3_5_FLASH.id, GEMINI_3_5_FLASH);
	return [...byId.values()];
}

function configureVertexEnvironment() {
	const project = firstNonEmpty(
		process.env.PI_VERTEX_AI_PROJECT,
		process.env.GOOGLE_CLOUD_PROJECT,
		process.env.GCLOUD_PROJECT,
		gcloudConfigValue("project"),
	);

	if (project) {
		process.env.GOOGLE_CLOUD_PROJECT = project;
		process.env.GCLOUD_PROJECT = project;
	}

	const location = firstNonEmpty(
		process.env.PI_VERTEX_AI_LOCATION,
		process.env.GOOGLE_CLOUD_LOCATION,
		process.env.GOOGLE_VERTEX_LOCATION,
		process.env.CLOUD_ML_REGION,
		gcloudConfigValue("ai/region"),
		DEFAULT_LOCATION,
	);

	process.env.GOOGLE_CLOUD_LOCATION = location;

	// pi-ai's built-in google-vertex stream treats this marker as "do not use API key".
	// This forces Application Default Credentials / gcloud auth instead of the API-key flow.
	if (process.env.PI_VERTEX_AI_FORCE_ADC !== "0") {
		process.env.GOOGLE_CLOUD_API_KEY = ADC_API_KEY_MARKER;
	}

	return { project, location };
}

export default function vertexAiProvider(pi: ExtensionAPI) {
	const env = configureVertexEnvironment();

	pi.registerProvider(PROVIDER_ID, {
		name: "Google Vertex AI (ADC)",
		baseUrl: VERTEX_BASE_URL,
		apiKey: ADC_API_KEY_MARKER,
		api: "google-vertex",
		models: getVertexModels(),
	});

	pi.registerCommand("vertex-ai-status", {
		description: "Show Vertex AI ADC project/location setup",
		handler: async (_args, ctx) => {
			const current = configureVertexEnvironment();
			const project = current.project ?? "missing";
			const location = current.location;
			const message = [
				`Vertex AI provider: ${PROVIDER_ID}`,
				`Auth mode: Application Default Credentials (no API key)`,
				`Extra model: ${GEMINI_3_5_FLASH.id}`,
				`Project: ${project}`,
				`Location: ${location}`,
				project === "missing"
					? "Set PI_VERTEX_AI_PROJECT or run: gcloud config set project YOUR_PROJECT_ID"
					: "If auth fails, run: gcloud auth application-default login",
			].join("\n");

			if (ctx.hasUI) ctx.ui.notify(message, project === "missing" ? "warning" : "info");
			else console.log(message);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!env.project) {
			ctx.ui.notify(
				"Vertex AI ADC provider loaded, but no project was found. Set PI_VERTEX_AI_PROJECT or run `gcloud config set project YOUR_PROJECT_ID`.",
				"warning",
			);
		}
	});
}
