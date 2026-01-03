/**
 * Unreal Engine Documentation Search Module
 * Uses Puppeteer with stealth plugin to search dev.epicgames.com documentation
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import path from 'path';
import fs from 'fs';

// Add stealth plugin to avoid Cloudflare detection
puppeteer.use(StealthPlugin());

// Configuration
const CHROME_PATH = '/usr/bin/google-chrome';
const BASE_URL = 'https://dev.epicgames.com';
const DOCS_URL = `${BASE_URL}/documentation/en-us/unreal-engine`;
const COMMUNITY_SEARCH_URL = `${BASE_URL}/community/search`;
// Use absolute path to avoid issues when running from different CWDs
const USER_DATA_DIR = '/tmp/unreal-analyzer-chrome-data';

// Ensure data dir exists
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

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
 * Get or create a browser instance with persistent context
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    console.error('[docs-search] Launching browser with persistent context...');
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      userDataDir: USER_DATA_DIR, // PERSISTENT SESSION DATA
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--start-maximized',
        '--lang=en-US,en;q=0.9',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    }) as unknown as Browser;
  }
  return browserInstance;
}

/**
 * Configure a page with human-like properties
 */
async function configurePage(page: Page): Promise<void> {
  // Randomize viewport slightly each session to avoid fingerprinting
  const width = Math.floor(1300 + Math.random() * 200);
  const height = Math.floor(850 + Math.random() * 150);
  await page.setViewport({ width, height });

  // Use a modern, realistic User Agent
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
}

/**
 * Handle Cloudflare/Turnstile challenges
 */
async function handleChallenges(page: Page): Promise<boolean> {
  let attempts = 0;
  while (attempts < 15) {
    const title = await page.title();
    const content = await page.content();
    
    // Check for challenge indicators
    const isChallenge = title.includes('moment') || 
                       title.includes('Just a') || 
                       content.includes('cf-challenge') ||
                       content.includes('ray-id');

    if (!isChallenge) {
      // Small delay after challenge clears to let JS initialize
      await new Promise(resolve => setTimeout(resolve, 2000));
      return true;
    }

    console.error(`[docs-search] Challenge active (attempt ${attempts + 1})...`);
    
    // Try to find and click the "Verify you are human" checkbox if visible
    try {
      const frames = page.frames();
      for (const frame of frames) {
        if (frame.url().includes('turnstile') || frame.url().includes('captcha')) {
          const checkbox = await frame.$('input[type="checkbox"], #challenge-stage');
          if (checkbox) {
            console.error('[docs-search] Found verification checkbox, attempting click...');
            await checkbox.click();
          }
        }
      }
    } catch (e) {
      // Ignore click errors
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
    attempts++;
  }
  return false;
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
 * Search Unreal Engine documentation using DuckDuckGo HTML (Lite) version
 * This version works without JS and is more bot-friendly
 */
async function searchDocsViaDuckDuckGo(
  query: string,
  version: string = '5.7',
  maxResults: number = 10
): Promise<SearchResult[]> {
  const cacheKey = `ddg:${query}:${version}:${maxResults}`;
  const cached = getFromCache<SearchResult[]>(cacheKey);
  if (cached) return cached;

  console.error('[docs-search] DuckDuckGo HTML search for:', query, 'version:', version);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await configurePage(page);

    // Use DDG HTML (Lite) version which doesn't require JS
    // Include version in query for version-specific results
    const ddgQuery = `${query} "unreal engine ${version}" site:dev.epicgames.com`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ddgQuery)}`;
    
    console.error('[docs-search] Navigating to DDG HTML:', ddgUrl);
    await page.goto(ddgUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    // DDG HTML version uses .links_main for results
    
    $('.links_main').each((i, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      const $link = $el.find('a.result__a').first();
      let href = $link.attr('href') || '';
      
      // DDG uses redirect URLs, extract actual URL
      if (href.includes('uddg=')) {
        const match = href.match(/uddg=([^&]+)/);
        if (match) {
          href = decodeURIComponent(match[1]);
        }
      }
      
      if (!href.includes('dev.epicgames.com')) return;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);
      
      const title = $el.find('.result__title, .result__a').first().text().trim().replace(/\s+/g, ' ');
      const snippet = $el.find('.result__snippet').text().trim();

      if (title && title.length > 3) {
        results.push({
          title: title,
          url: href,
          snippet: snippet.substring(0, 400),
          type: 'documentation',
        });
      }
    });

    console.error(`[docs-search] DuckDuckGo found ${results.length} results`);
    setInCache(cacheKey, results);
    return results;
  } catch (error) {
    console.error('[docs-search] DuckDuckGo error:', error instanceof Error ? error.message : error);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Search Unreal Engine documentation
 */
export async function searchDocs(
  query: string,
  version: string = '5.7',
  maxResults: number = 10
): Promise<SearchResult[]> {
  console.error(`[docs-search] Searching documentation for: ${query} (UE ${version})`);
  
  // Try DuckDuckGo HTML (Lite) first - it's the most reliable for headless bots
  const results = await searchDocsViaDuckDuckGo(query, version, maxResults);
  
  // Fallback to Google if DDG fails
  if (results.length === 0) {
    console.error('[docs-search] DDG returned 0 results, falling back to Google...');
    return searchDocsViaGoogle(query, maxResults);
  }
  
  return results;
}

/**
 * Fetch and parse a documentation page
 */
export async function fetchDocPage(url: string): Promise<DocPage | null> {
  const cacheKey = `page:${url}`;
  const cached = getFromCache<DocPage>(cacheKey);
  if (cached) {
    console.error('[docs-search] Cache hit for page:', url);
    return cached;
  }

  console.error('[docs-search] Fetching page:', url);
  
  let browser: Browser;
  let page: Page;
  
  try {
    browser = await getBrowser();
    page = await browser.newPage();
  } catch (error) {
    console.error('[docs-search] Failed to create browser/page:', error);
    return null;
  }

  try {
    await configurePage(page);

    // Use domcontentloaded for faster response, with shorter timeout
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Short wait for any JS to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Quick challenge check (max 10 seconds, non-blocking)
    const challengeTimeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000));
    const challengeCheck = handleChallenges(page);
    await Promise.race([challengeCheck, challengeTimeout]);
    
    // Brief wait for content
    await new Promise(resolve => setTimeout(resolve, 1000));

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
    console.error('[docs-search] Cache hit for Google search:', query);
    return cached;
  }

  console.error('[docs-search] Google search for:', query);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await configurePage(page);

    // Search specifically for Unreal documentation on Google
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
      query + ' site:dev.epicgames.com/documentation/en-us/unreal-engine/'
    )}`;
    
    console.error('[docs-search] Navigating to Google:', googleUrl);
    await page.goto(googleUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Handle consent screens
    const title = await page.title();
    if (title.includes('Consent') || title.includes('Before you continue')) {
      const buttons = await page.$$('button');
      for (const button of buttons) {
        const text = await page.evaluate(el => el.textContent, button);
        if (text?.includes('Accept all') || text?.includes('Agree')) {
          await button.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
          break;
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    console.error('[docs-search] Parsing results with universal strategy...');

    // Aggressive universal parser: Find any link to epic docs
    $('a[href*="dev.epicgames.com/documentation/en-us/unreal-engine/"]').each((i, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      let href = $el.attr('href');
      if (!href) return;

      // Clean redirect URLs
      if (href.includes('/url?')) {
        const match = href.match(/url=([^&]+)/);
        if (match) href = decodeURIComponent(match[1]);
      }

      // Final cleanup
      if (href.includes('&')) href = href.split('&')[0];
      if (href.includes('?')) href = href.split('?')[0];

      if (seenUrls.has(href)) return;
      
      // Look for a reasonable title (either the link text or a nearby heading)
      let title = $el.text().trim();
      if (!title || title.length < 5) {
        title = $el.find('h1, h2, h3, h4').first().text().trim();
      }
      
      // If still no title, skip (likely a footer or nav link)
      if (!title || title.length < 5) return;

      seenUrls.add(href);
      
      // Find a snippet (text in the parent container)
      const $parent = $el.closest('div, li, section').first();
      const snippet = $parent.text().replace(title, '').substring(0, 400).trim();

      results.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: href,
        snippet: snippet.replace(/\s+/g, ' '),
        type: 'documentation',
      });
    });

    // If still no results, try one more time with a simpler link extraction
    if (results.length === 0) {
      console.error('[docs-search] No results with aggressive strategy, trying simple extraction...');
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('dev.epicgames.com/documentation/en-us/unreal-engine/')) {
          const text = $(el).text().trim();
          if (text.length > 10) {
            results.push({
              title: text,
              url: href,
              snippet: '',
              type: 'documentation'
            });
          }
        }
      });
    }

    console.error(`[docs-search] Universal found ${results.length} documentation pages`);
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
      console.error(`[docs-search] Found ${className} in ${modulePath}`);
      return page;
    }
  }

  console.error(`[docs-search] Class not found in common modules, falling back to search`);
  
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
