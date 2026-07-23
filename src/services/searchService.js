import { cacheService } from './cacheService.js';

/**
 * Normalize Arabic text by removing diacritics and unifying Alef, Teh Marbouta, and Yae variants.
 * @param {string} text
 * @returns {string}
 */
export function normalizeArabic(text) {
  if (!text) return '';
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, '') // Remove diacritics (Fatha, Damma, Kasra, etc.)
    .replace(/[أإآ]/g, 'ا')         // Unify Alefs to bare Alef
    .replace(/ة/g, 'ه')             // Unify Teh Marbouta to Heh
    .replace(/[يى]/g, 'ي')          // Unify Dotless Yae (Alif Maqsurah) and Yae
    .replace(/\s+/g, ' ');          // Collapse double spacing
}

/**
 * Calculate Levenshtein distance between two normalized words.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function getLevenshteinDistance(a, b) {
  const tmp = [];
  for (let i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,       // Deletion
        tmp[i][j - 1] + 1,       // Insertion
        tmp[i - 1][j - 1] + cost  // Substitution
      );
    }
  }
  return tmp[a.length][b.length];
}

export const searchService = {
  /**
   * Search audios cached in memory using substring, word-overlap, and Levenshtein distance.
   * @param {string} query
   * @returns {Array<object>} - Sorted list of matching audios
   */
  search(query) {
    if (!query || !query.trim()) return [];

    const normQuery = normalizeArabic(query);
    const queryWords = normQuery.split(' ').filter(w => w.length > 0);
    const cachedAudios = cacheService.getBooks();
    const matches = [];

    for (const audio of cachedAudios) {
      const titleNorm = normalizeArabic(audio.title);
      const presenterNorm = normalizeArabic(audio.presenter);
      const categoryNorm = normalizeArabic(audio.category);
      const descNorm = normalizeArabic(audio.description || '');
      const keywordsNorm = normalizeArabic(audio.keywords || '');

      let score = 0;

      // 1. Direct match on full query (High Priority)
      if (titleNorm === normQuery) {
        score += 150;
      } else if (titleNorm.includes(normQuery)) {
        score += 100;
      } else if (presenterNorm.includes(normQuery)) {
        score += 80;
      } else if (keywordsNorm.includes(normQuery)) {
        score += 60;
      } else if (categoryNorm.includes(normQuery)) {
        score += 40;
      } else if (descNorm.includes(normQuery)) {
        score += 20;
      }

      // 2. Word matching (for multi-word searches)
      let matchedWordsCount = 0;
      for (const word of queryWords) {
        if (titleNorm.includes(word)) {
          score += 20;
          matchedWordsCount++;
        } else if (presenterNorm.includes(word)) {
          score += 15;
          matchedWordsCount++;
        } else if (keywordsNorm.includes(word)) {
          score += 10;
          matchedWordsCount++;
        } else if (categoryNorm.includes(word)) {
          score += 5;
          matchedWordsCount++;
        }
      }

      // Boost score if all search words match somewhere
      if (queryWords.length > 1 && matchedWordsCount === queryWords.length) {
        score += 50;
      }

      // 3. Fuzzy Levenshtein Distance matching for single-word queries
      if (queryWords.length === 1 && normQuery.length >= 3) {
        const titleWords = titleNorm.split(' ');
        for (const titleWord of titleWords) {
          if (titleWord.length >= 3) {
            const distance = getLevenshteinDistance(normQuery, titleWord);
            if (distance === 1) {
              score += 30; // Minor typo
            } else if (distance === 2) {
              score += 10; // Medium typo
            }
          }
        }
      }

      if (score > 0) {
        matches.push({ audio, score });
      }
    }

    // Sort audios descending by match relevance score
    return matches
      .sort((a, b) => b.score - a.score)
      .map(m => m.audio);
  }
};
