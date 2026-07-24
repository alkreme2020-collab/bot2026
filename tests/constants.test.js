import { describe, it, expect } from 'vitest';
import { SUPPORTED_AUDIO_MIMETYPES, SUPPORTED_EXTENSIONS, EXTENSION_TO_MIMETYPE, MAIN_MENU_OPTIONS } from '../src/constants/audio.js';

describe('audio constants', () => {
  it('has valid mime types', () => {
    expect(SUPPORTED_AUDIO_MIMETYPES.length).toBeGreaterThan(0);
    SUPPORTED_AUDIO_MIMETYPES.forEach(mime => {
      expect(mime).toMatch(/^audio\//);
    });
  });

  it('has valid extensions', () => {
    expect(SUPPORTED_EXTENSIONS.length).toBeGreaterThan(0);
    SUPPORTED_EXTENSIONS.forEach(ext => {
      expect(ext).toMatch(/^\./);
    });
  });

  it('has consistent extension-to-mimetype map', () => {
    Object.entries(EXTENSION_TO_MIMETYPE).forEach(([ext, mime]) => {
      expect(SUPPORTED_EXTENSIONS).toContain(ext);
      expect(SUPPORTED_AUDIO_MIMETYPES).toContain(mime);
    });
  });

  it('has main menu options', () => {
    expect(MAIN_MENU_OPTIONS.length).toBe(8);
    expect(MAIN_MENU_OPTIONS[0]).toContain('بحث');
  });
});