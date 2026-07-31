export const SUPPORTED_AUDIO_MIMETYPES = [
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
  'audio/x-wav', 'audio/webm', 'audio/aac', 'audio/flac',
  'audio/x-m4a', 'audio/mp3',
];

export const SUPPORTED_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.webm', '.flac', '.opus'];

export const EXTENSION_TO_MIMETYPE = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
};

export const SUPPORTED_VIDEO_MIMETYPES = [
  'video/mp4', 'video/x-matroska', 'video/webm', 'video/avi',
  'video/quicktime', 'video/x-msvideo',
];

export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];

export const VIDEO_EXTENSION_TO_MIMETYPE = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

export const SUPPORTED_BOOK_MIMETYPES = [
  'application/pdf',
  'application/epub+zip',
  'application/x-mobipocket-ebook',
  'application/octet-stream',
];

export const SUPPORTED_BOOK_EXTENSIONS = ['.pdf', '.epub', '.mobi'];

export const BOOK_EXTENSION_TO_MIMETYPE = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
};

export const CONTENT_TYPES = {
  audio: { key: 'audio', label: 'صوتيات', emoji: '🎧' },
  video: { key: 'video', label: 'فيديوهات', emoji: '🎬' },
  book: { key: 'book', label: 'كتب', emoji: '📚' },
};

export const MAIN_MENU_OPTIONS = [
  "🔍 بحث عن محتوى",
  "📂 التصنيفات",
  "🎧 جميع الصوتيات",
  "🎬 جميع الفيديوهات",
  "📚 جميع الكتب",
  "🆕 صوتية الأسبوع",
  "🎬 فيديو الأسبوع",
  "📖 كتاب الأسبوع",
  "➕ إضافة محتوى",
  "🔔 الاشتراك",
  "ℹ️ نبذة عن البوت",
  "📊 إحصائيات المكتبة"
];