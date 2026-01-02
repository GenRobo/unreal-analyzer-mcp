/**
 * Unreal Engine Documentation Search Module
 * Uses Puppeteer to search dev.epicgames.com documentation
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';

// Configuration
const CHROME_PATH = '/usr/bin/google-chrome';
const BASE_URL = 'https://dev.epicgames.com';
const DOCS_URL = `${BASE_URL}/documentation/en-us/unreal-engine`;
const COMMUNITY_SEARCH_URL = `${BASE_URL}/community/search`;

// Cache for search results (TTL: 1 hour)
interface CacheEntry {
  data: any;
  timestamp: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Browser instance (lazy-initialized)
let browserInstance: Browser | null = null;

/**
 * Get or create a browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    console.log('[docs-search] Launching browser...');
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
  }
  return browserInstance;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Check cache for a key
 */
function getFromCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

/**
 * Store in cache
 */
function setInCache(key: string, data: any): void {
  cache.set(key, { data, timestamp: Date.now() });
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  type?: string;
}

export interface DocPage {
  title: string;
  url: string;
  content: string;
  headings: string[];
  codeBlocks: string[];
}

/**
 * Search Unreal Engine documentation using community search
 */
export async function searchDocs(
  query: string,
  version: string = '5.7',
  maxResults: number = 10
): Promise<SearchResult[]> {
  const cacheKey = `search:${query}:${version}:${maxResults}`;
  const cached = getFromCache<SearchResult[]>(cacheKey);
  if (cached) {
    console.log('[docs-search] Cache hit for:', query);
    return cached;
  }

  console.log('[docs-search] Searching for:', query);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to community search
    const searchUrl = `${COMMUNITY_SEARCH_URL}?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for search results to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Give time for dynamic content to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get page content
    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];

    // Parse search results - adjust selectors based on actual page structure
    // The community site uses various result card formats
    $('a[href*="/documentation/"]').each((i, el) => {
      if (results.length >= maxResults) return false;
      
      const $el = $(el);
      const href = $el.attr('href');
      const title = $el.text().trim();
      
      if (href && title && title.length > 0 && !title.includes('Skip to')) {
        // Get parent container for snippet
        const $parent = $el.closest('div, article, section');
        const snippet = $parent.find('p, .description, .snippet').first().text().trim() || '';
        
        results.push({
          title: title.substring(0, 200),
          url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
          snippet: snippet.substring(0, 300),
          type: 'documentation',
        });
      }
    });

    // Deduplicate by URL
    const uniqueResults = results.filter(
      (r, i, arr) => arr.findIndex(x => x.url === r.url) === i
    );

    setInCache(cacheKey, uniqueResults);
    return uniqueResults;
  } catch (error) {
    console.error('[docs-search] Search error:', error);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Fetch and parse a documentation page
 */
export async function fetchDocPage(url: string): Promise<DocPage | null> {
  const cacheKey = `page:${url}`;
  const cached = getFromCache<DocPage>(cacheKey);
  if (cached) {
    console.log('[docs-search] Cache hit for page:', url);
    return cached;
  }

  console.log('[docs-search] Fetching page:', url);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Extract page title
    const title = $('h1').first().text().trim() || $('title').text().trim();

    // Extract main content (adjust selector for Epic docs structure)
    const contentSelectors = [
      'main article',
      '.documentation-content',
      '.content-body',
      'main',
      'article',
    ];
    
    let content = '';
    for (const selector of contentSelectors) {
      const $content = $(selector);
      if ($content.length) {
        content = $content.text().trim();
        break;
      }
    }

    // Extract headings for navigation/structure
    const headings: string[] = [];
    $('h1, h2, h3, h4').each((i, el) => {
      const text = $(el).text().trim();
      if (text && !headings.includes(text)) {
        headings.push(text);
      }
    });

    // Extract code blocks
    const codeBlocks: string[] = [];
    $('pre code, .code-block, code').each((i, el) => {
      const code = $(el).text().trim();
      if (code && code.length > 20) {
        codeBlocks.push(code);
      }
    });

    const docPage: DocPage = {
      title,
      url,
      content: content.substring(0, 50000), // Limit content size
      headings: headings.slice(0, 20),
      codeBlocks: codeBlocks.slice(0, 10),
    };

    setInCache(cacheKey, docPage);
    return docPage;
  } catch (error) {
    console.error('[docs-search] Fetch page error:', error);
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Search using Google with site filter (fallback)
 */
export async function searchDocsViaGoogle(
  query: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
  const cacheKey = `google:${query}:${maxResults}`;
  const cached = getFromCache<SearchResult[]>(cacheKey);
  if (cached) {
    return cached;
  }

  console.log('[docs-search] Google search for:', query);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
      query + ' site:dev.epicgames.com/documentation'
    )}`;
    
    await page.goto(googleUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 1000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];

    // Parse Google search results
    $('div.g, div[data-hveid]').each((i, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      const $link = $el.find('a[href*="dev.epicgames.com"]').first();
      const href = $link.attr('href');
      const title = $link.find('h3').text().trim() || $link.text().trim();
      const snippet = $el.find('.VwiC3b, .s, span[style]').text().trim();

      if (href && title && href.includes('dev.epicgames.com')) {
        results.push({
          title,
          url: href,
          snippet: snippet.substring(0, 300),
          type: 'documentation',
        });
      }
    });

    setInCache(cacheKey, results);
    return results;
  } catch (error) {
    console.error('[docs-search] Google search error:', error);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Get documentation page by class name
 */
export async function getClassDocumentation(
  className: string,
  version: string = '5.7'
): Promise<DocPage | null> {
  // First try direct URL pattern
  const directUrl = `${DOCS_URL}/API/Runtime/Engine/${className}?application_version=${version}`;
  
  // Try to fetch directly
  let page = await fetchDocPage(directUrl);
  if (page && page.content.length > 100) {
    return page;
  }

  // Fall back to search
  const results = await searchDocs(className, version, 5);
  const match = results.find(r => 
    r.title.toLowerCase().includes(className.toLowerCase()) ||
    r.url.toLowerCase().includes(className.toLowerCase())
  );

  if (match) {
    return fetchDocPage(match.url);
  }

  return null;
}

// Cleanup on process exit
process.on('exit', () => {
  closeBrowser().catch(() => {});
});

process.on('SIGINT', () => {
  closeBrowser().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  closeBrowser().then(() => process.exit(0));
});
