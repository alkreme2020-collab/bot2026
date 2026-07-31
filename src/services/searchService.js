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
    .replace(/[\u064B-\u0652]/g, '') // Remove diacritics
    .replace(/[أإآ]/g, 'ا')         // Unify Alefs
    .replace(/ة/g, 'ه')             // Unify Teh Marbouta
    .replace(/[يى]/g, 'ي')          // Unify Yae
    .replace(/\s+/g, ' ');          // Collapse spaces
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
   * Search items cached in memory using substring, word-overlap, and Levenshtein distance.
   * @param {string} query
   * @param {string} [contentType='audio'] - 'audio', 'video', or 'book'
   * @returns {Array<object>} - Sorted list of matching items
   */
  search(query, contentType = 'audio') {
    if (!query || !query.trim()) return [];

    const normQuery = normalizeArabic(query);
    const queryWords = normQuery.split(' ').filter(w => w.length > 0);
    
    let cachedItems = [];
    if (contentType === 'video') {
      cachedItems = cacheService.getVideos();
    } else if (contentType === 'book') {
      cachedItems = cacheService.getBooks();
    } else {
      cachedItems = cacheService.getAudios();
    }

    const matches = [];

    for (const item of cachedItems) {
      const titleNorm = normalizeArabic(item.title);
      const authorOrPresenterNorm = normalizeArabic(item.presenter || item.author || '');
      const categoryNorm = normalizeArabic(item.category);
      const descNorm = normalizeArabic(item.description || '');
      const keywordsNorm = normalizeArabic(item.keywords || '');

      let score = 0;

      // 1. Direct match on full query
      if (titleNorm === normQuery) {
        score += 150;
      } else if (titleNorm.includes(normQuery)) {
        score += 100;
      } else if (authorOrPresenterNorm.includes(normQuery)) {
        score += 80;
      } else if (keywordsNorm.includes(normQuery)) {
        score += 60;
      } else if (categoryNorm.includes(normQuery)) {
        score += 40;
      } else if (descNorm.includes(normQuery)) {
        score += 20;
      }

      // 2. Word matching
      let matchedWordsCount = 0;
      for (const word of queryWords) {
        if (titleNorm.includes(word)) {
          score += 20;
          matchedWordsCount++;
        } else if (authorOrPresenterNorm.includes(word)) {
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

      if (queryWords.length > 1 && matchedWordsCount === queryWords.length) {
        score += 50;
      }

      // 3. Fuzzy Levenshtein Distance matching
      if (queryWords.length === 1 && normQuery.length >= 3) {
        const titleWords = titleNorm.split(' ');
        for (const titleWord of titleWords) {
          if (titleWord.length >= 3) {
            const distance = getLevenshteinDistance(normQuery, titleWord);
            if (distance === 1) {
              score += 30;
            } else if (distance === 2) {
              score += 10;
            }
          }
        }
      }

      if (score > 0) {
        matches.push({ item, score });
      }
    }

    return matches
      .sort((a, b) => b.score - a.score)
      .map(m => m.item);
  }
};
