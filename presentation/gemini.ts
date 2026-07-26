/**
 * Minimal Gemini image-generation client — one generateContent call, no SDK.
 * Shared by gen-images.ts (deck photography) and gen-logo.ts (logo marks).
 */

/**
 * The "Nano Banana" family. Pro is the default and has been all along; the
 * others are here so a concept can be run across all three and compared.
 */
export const MODELS = {
  /** Nano Banana Pro — the strongest, and the default. */
  pro: "gemini-3-pro-image",
  /** Nano Banana — the original gemini-2.5-flash-image. */
  nano: "gemini-2.5-flash-image",
  /** The newer flash tier. */
  flash: "gemini-3.1-flash-image",
} as const;

export type ModelKey = keyof typeof MODELS;

export const MODEL = MODELS.pro;

export type AspectRatio =
  | "1:1"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

export const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const apiKey = (): string => {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (key === undefined || key === "") {
    throw new Error("GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) is required");
  }
  return key;
};

type InlineData = { readonly data: string; readonly mimeType?: string };
type Part = { readonly inlineData?: InlineData; readonly text?: string };
type GenerateResponse = {
  readonly candidates?: readonly { readonly content?: { readonly parts?: readonly Part[] } }[];
  readonly error?: { readonly message?: string };
  readonly promptFeedback?: { readonly blockReason?: string };
};

const MIME_BY_EXT: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Reference images sent alongside the prompt. Describing a piece of hardware in
 * words only gets you so far — handing the model a photograph of the actual rig
 * gets the construction right, and keeps generated marks consistent with the
 * photography already in the deck.
 */
const referenceParts = async (paths: readonly string[]) =>
  Promise.all(
    paths.map(async (p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      const bytes = await Bun.file(p).arrayBuffer();
      return {
        inlineData: {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: MIME_BY_EXT[ext] ?? "image/jpeg",
        },
      };
    })
  );

/** Generate one image. Throws with the API's own message on failure. */
export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: "1K" | "2K" | "4K" = "2K",
  references: readonly string[] = [],
  model: string = MODEL
): Promise<{ bytes: Buffer; mimeType: string }> => {
  const refs = await referenceParts(references);

  const call = async (withImageConfig: boolean) =>
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        body: JSON.stringify({
          contents: [{ parts: [...refs, { text: prompt }], role: "user" }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(withImageConfig ? { imageConfig: { aspectRatio, imageSize } } : {}),
          },
        }),
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
        method: "POST",
      }
    );

  // The older flash tiers reject imageConfig; fall back rather than fail.
  let res = await call(true);
  let body = (await res.json()) as GenerateResponse;
  if (!res.ok && /imageConfig|image_config|aspect|Unknown name/i.test(body.error?.message ?? "")) {
    res = await call(false);
    body = (await res.json()) as GenerateResponse;
  }

  if (!res.ok || body.error !== undefined) {
    throw new Error(`${res.status}: ${body.error?.message ?? "unknown error"}`);
  }
  if (body.promptFeedback?.blockReason !== undefined) {
    throw new Error(`blocked: ${body.promptFeedback.blockReason}`);
  }

  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData !== undefined)?.inlineData;
  if (image === undefined) {
    const said = parts.map((p) => p.text ?? "").join(" ").slice(0, 300);
    throw new Error(`no image part returned${said === "" ? "" : ` — model said: ${said}`}`);
  }

  return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType ?? "image/png" };
};
