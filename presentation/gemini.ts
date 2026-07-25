/**
 * Minimal Gemini image-generation client — one generateContent call, no SDK.
 * Shared by gen-images.ts (deck photography) and gen-logo.ts (logo marks).
 */

export const MODEL = "gemini-3-pro-image";

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

/** Generate one image. Throws with the API's own message on failure. */
export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: "1K" | "2K" | "4K" = "2K"
): Promise<{ bytes: Buffer; mimeType: string }> => {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: {
          imageConfig: { aspectRatio, imageSize },
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
      method: "POST",
    }
  );

  const body = (await res.json()) as GenerateResponse;
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
