import { downloadContentFromMessage } from '@whiskeysockets/baileys';

export function getMediaMessageInfo(msg) {
  let m = msg?.message;
  if (!m) return null;
  
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

  if (m.imageMessage) return { message: m.imageMessage, type: 'image' };
  if (m.videoMessage) return { message: m.videoMessage, type: 'video' };
  if (m.audioMessage) return { message: m.audioMessage, type: 'audio' };
  if (m.documentMessage) return { message: m.documentMessage, type: 'document' };
  if (m.stickerMessage) return { message: m.stickerMessage, type: 'sticker' };

  return null;
}

export async function downloadMedia(rawMsg) {
  const mediaInfo = getMediaMessageInfo(rawMsg);
  if (!mediaInfo) {
    throw new Error('No media found in the message');
  }

  const stream = await downloadContentFromMessage(mediaInfo.message, mediaInfo.type);
  let buffer = Buffer.from([]);
  for await(const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}
