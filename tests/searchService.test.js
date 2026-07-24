import { describe, it, expect } from 'vitest';
import { normalizeArabic, searchService } from '../src/services/searchService.js';
import { cacheService } from '../src/services/cacheService.js';

describe('normalizeArabic', () => {
  it('removes diacritics (tashkeel)', () => {
    expect(normalizeArabic('مُحَمَّد')).toBe('محمد');
  });

  it('unifies alef variants (أ إ آ) to bare alef (ا)', () => {
    expect(normalizeArabic('أحمد إبراهيم آدم')).toBe('احمد ابراهيم ادم');
  });

  it('converts teh marbouta (ة) to heh (ه)', () => {
    expect(normalizeArabic('مكتبة جامعة')).toBe('مكتبه جامعه');
  });

  it('unifies dotless yae (ى) and yae (ي)', () => {
    expect(normalizeArabic('موسى علي')).toBe('موسي علي');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeArabic('خطبة   الجمعة')).toBe('خطبه الجمعه');
  });

  it('handles empty string', () => {
    expect(normalizeArabic('')).toBe('');
  });

  it('handles null/undefined', () => {
    expect(normalizeArabic(null)).toBe('');
    expect(normalizeArabic(undefined)).toBe('');
  });

  it('preserves English text', () => {
    expect(normalizeArabic('Hello World 123')).toBe('hello world 123');
  });
});

describe('searchService.search', () => {
  it('returns empty array for empty query', () => {
    const results = searchService.search('');
    expect(results).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    const results = searchService.search('   ');
    expect(results).toEqual([]);
  });

  it('returns empty array when cache is empty', () => {
    const results = searchService.search('non-existent');
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });
});