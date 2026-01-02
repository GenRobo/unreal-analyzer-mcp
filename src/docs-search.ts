/**
 * Unreal Engine Documentation Search Module
 * Uses Puppeteer with stealth plugin to search dev.epicgames.com documentation
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';

// Add stealth plugin to avoid Cloudflare detection
puppeteer.use(StealthPlugin());

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
    console.log('[docs-search] Launching browser with stealth mode...');
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new', // Use new headless mode (less detectable)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--start-maximized',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    }) as unknown as Browser;
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
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to community search page (without query param - we'll type it)
    console.log('[docs-search] Navigating to search page...');
    await page.goto(COMMUNITY_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for Cloudflare challenge to complete
    let attempts = 0;
    while (attempts < 10) {
      const title = await page.title();
      if (!title.includes('moment') && !title.includes('Just a')) {
        break;
      }
      console.log('[docs-search] Waiting for Cloudflare challenge...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
    }

    // Wait for search input to be visible
    console.log('[docs-search] Waiting for search input...');
    const searchInputSelector = 'input[type="text"], input[type="search"], input[placeholder*="earch"]';
    await page.waitForSelector(searchInputSelector, { timeout: 15000 });
    
    // Find and click the search input
    const searchInput = await page.$(searchInputSelector);
    if (!searchInput) {
      console.log('[docs-search] Could not find search input');
      return [];
    }
    
    await searchInput.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Type the search query
    console.log('[docs-search] Typing query:', query);
    await page.keyboard.type(query, { delay: 50 });
    
    // Press Enter to submit
    await page.keyboard.press('Enter');
    
    // Wait for results to load
    console.log('[docs-search] Waiting for results...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Wait for network to settle
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

    // Get page content
    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    console.log('[docs-search] Parsing results...');

    // Try multiple selectors for search results
    // 1. Links to documentation pages
    $('a[href*="/documentation/"]').each((i, el) => {
      if (results.length >= maxResults) return false;
      
      const $el = $(el);
      const href = $el.attr('href');
      let title = $el.text().trim();
      
      // Skip navigation/breadcrumb links
      if (!href || !title || title.length < 3 || title.length > 300) return;
      if (title.includes('Skip to') || title.includes('breadcrumb')) return;
      if (href.includes('#') && !href.includes('?')) return; // Skip anchor-only links
      
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);
      
      // Get parent container for snippet
      const $parent = $el.closest('div, article, li, section').first();
      let snippet = '';
      
      // Try to find description text near the link
      const $desc = $parent.find('p, span, .description, .snippet, .summary').first();
      if ($desc.length) {
        snippet = $desc.text().trim();
      }
      
      // Clean up title (remove extra whitespace)
      title = title.replace(/\s+/g, ' ').trim();
      
      results.push({
        title: title.substring(0, 200),
        url: fullUrl,
        snippet: snippet.substring(0, 400),
        type: 'documentation',
      });
    });

    // 2. Also look for result cards/items with different structure
    $('[class*="result"], [class*="card"], [class*="item"]').each((i, el) => {
      if (results.length >= maxResults) return false;
      
      const $el = $(el);
      const $link = $el.find('a[href*="/documentation/"], a[href*="unreal-engine"]').first();
      if (!$link.length) return;
      
      const href = $link.attr('href');
      if (!href) return;
      
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);
      
      const title = $link.text().trim() || $el.find('h1, h2, h3, h4, .title').first().text().trim();
      const snippet = $el.find('p, .description, .summary').first().text().trim();
      
      if (title && title.length > 3) {
        results.push({
          title: title.substring(0, 200),
          url: fullUrl,
          snippet: snippet.substring(0, 400),
          type: 'documentation',
        });
      }
    });

    console.log(`[docs-search] Found ${results.length} results`);
    setInCache(cacheKey, results);
    return results;
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
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for Cloudflare challenge to complete
    let attempts = 0;
    while (attempts < 10) {
      const title = await page.title();
      if (!title.includes('moment') && !title.includes('Just a')) {
        break;
      }
      console.log('[docs-search] Waiting for Cloudflare challenge...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
    }
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 3000));

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
    console.log('[docs-search] Cache hit for Google search:', query);
    return cached;
  }

  console.log('[docs-search] Google search for:', query);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
      query + ' site:dev.epicgames.com/documentation'
    )}`;
    
    console.log('[docs-search] Navigating to Google:', googleUrl);
    await page.goto(googleUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    // Parse Google search results - try multiple selectors
    // Main result divs
    $('div.g, div[data-hveid], div[data-sokoban-container]').each((i, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      const $link = $el.find('a[href*="dev.epicgames.com"]').first();
      let href = $link.attr('href');
      
      if (!href || !href.includes('dev.epicgames.com')) return;
      
      // Clean Google redirect URLs
      if (href.includes('/url?')) {
        const match = href.match(/url=([^&]+)/);
        if (match) href = decodeURIComponent(match[1]);
      }
      
      if (seenUrls.has(href)) return;
      seenUrls.add(href);
      
      const title = $el.find('h3').first().text().trim() || $link.text().trim();
      const snippet = $el.find('.VwiC3b, [data-content-feature], span').filter((_, e) => {
        const text = $(e).text();
        return text.length > 50 && text.length < 500;
      }).first().text().trim();

      if (title && title.length > 3) {
        results.push({
          title: title.substring(0, 200),
          url: href,
          snippet: snippet.substring(0, 400),
          type: 'documentation',
        });
      }
    });

    // Also try getting all links to epic docs
    if (results.length === 0) {
      console.log('[docs-search] Trying fallback link extraction...');
      $('a[href*="dev.epicgames.com/documentation"]').each((i, el) => {
        if (results.length >= maxResults) return false;
        
        const $el = $(el);
        let href = $el.attr('href');
        if (!href) return;
        
        if (href.includes('/url?')) {
          const match = href.match(/url=([^&]+)/);
          if (match) href = decodeURIComponent(match[1]);
        }
        
        if (seenUrls.has(href)) return;
        seenUrls.add(href);
        
        const title = $el.text().trim();
        if (title && title.length > 3 && title.length < 200) {
          results.push({
            title,
            url: href,
            snippet: '',
            type: 'documentation',
          });
        }
      });
    }

    console.log(`[docs-search] Google found ${results.length} results`);
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
 * Searches across multiple common modules
 */
export async function getClassDocumentation(
  className: string,
  version: string = '5.7'
): Promise<DocPage | null> {
  // Common module paths to search
  const modulePaths = [
    'Engine',
    'RenderCore', 
    'RHI',
    'CoreUObject',
    'Core',
    'Renderer',
    'Slate',
    'SlateCore',
    'InputCore',
    'UMG',
    'AIModule',
    'NavigationSystem',
    'PhysicsCore',
  ];

  // Try each module path
  for (const modulePath of modulePaths) {
    const directUrl = `${DOCS_URL}/API/Runtime/${modulePath}/${className}?application_version=${version}`;
    
    // Try to fetch directly
    const page = await fetchDocPage(directUrl);
    
    // Check if we got a real class page (not a redirect to main docs)
    if (page && page.content.length > 100 && page.title.includes(className)) {
      console.log(`[docs-search] Found ${className} in ${modulePath}`);
      return page;
    }
  }

  console.log(`[docs-search] Class not found in common modules, falling back to search`);
  
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
