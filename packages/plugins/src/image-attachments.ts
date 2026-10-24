import type { ChatMessage } from "@hajicli/core";

/** OpenAI 兼容的多模态 content parts。 */
export type MultimodalContent = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

/**
 * 消息体转换：无附件时原样返回字符串；带图片附件时转为
 * text + image_url(data URI) 的 content parts（需视觉模型支持）。
 * 三个 Provider 的请求体组装共用。
 */
export function messageContentOrParts(
  msg: Pick<ChatMessage, "content" | "attachments">,
): string | MultimodalContent {
  if (!msg.attachments?.length) return msg.content;
  return [
    { type: "text", text: msg.content },
    ...msg.attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: `data:${attachment.mimeType};base64,${attachment.base64}` },
    })),
  ];
}
