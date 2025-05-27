// main.js - Instagram Scraper using Direct API Approach (2025)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import * as cheerio from 'cheerio';

await Actor.init();

const input = await Actor.getInput();

if (!input || (!input.usernames && !input.postUrls)) {
    throw new Error('Missing required input: Please provide either usernames or postUrls');
}

const {
    usernames = [],
    postUrls = [],
    maxPostsPerProfile = 50,
    includeComments = false,
    maxCommentsPerPost = 10,
    includeHashtags = true,
    includeMentions = true,
    includeLocation = true,
    includeEngagementMetrics = true,
    proxyConfiguration,
    maxRequestRetries = 3,
    requestHandlerTimeoutSecs = 30,
    maxConcurrency = 1,
    dateFrom,
    dateTo
} = input;

const dataset = await Dataset.open();

// This is the approach that actually works in 2025
// Based on research of successful scrapers
const extractInstagramDataDirect = async (crawler, username) => {
    console.log(`🎯 Attempting direct data extraction for: ${username}`);
    
    const strategies = [
        // Strategy 1: Try the classic profile page with enhanced parsing
        async () => {
            console.log('Strategy 1: Enhanced profile page parsing...');
            
            const profileUrl = `https://www.instagram.com/${username}/`;
            
            return new Promise((resolve) => {
                crawler.addRequests([{
                    url: profileUrl,
                    userData: { strategy: 'profile', username }
                }]);
                resolve(null);
            });
        },
        
        // Strategy 2: Try mobile Instagram (often less protected)
        async () => {
            console.log('Strategy 2: Mobile Instagram...');
            
            const mobileUrl = `https://m.instagram.com/${username}/`;
            
            return new Promise((resolve) => {
                crawler.addRequests([{
                    url: mobileUrl,
                    userData: { strategy: 'mobile', username }
                }]);
                resolve(null);
            });
        },
        
        // Strategy 3: Try with feed parameter (sometimes works)
        async () => {
            console.log('Strategy 3: Feed parameter approach...');
            
            const feedUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
            
            return new Promise((resolve) => {
                crawler.addRequests([{
                    url: feedUrl,
                    userData: { strategy: 'feed', username }
                }]);
                resolve(null);
            });
        }
    ];
    
    // Try each strategy
    for (const strategy of strategies) {
        try {
            await strategy();
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait between attempts
        } catch (error) {
            console.log('Strategy failed:', error.message);
            continue;
        }
    }
};

// Enhanced HTML parsing that actually finds the data
const parseInstagramHTML = (html, url, userData = {}) => {
    console.log(`📖 Parsing HTML for: ${url}`);
    console.log(`   Strategy: ${userData.strategy || 'unknown'}`);
    console.log(`   Size: ${html.length} bytes`);
    
    const $ = cheerio.load(html);
    
    // Check if we got a login redirect or error page
    const title = $('title').text().toLowerCase();
    if (title.includes('login') || title.includes('error') || title.includes('not found')) {
        console.log('❌ Got login/error page');
        return null;
    }
    
    // Strategy 1: Look for the new format Instagram uses
    console.log('🔍 Searching for Instagram data patterns...');
    
    // Method 1: Look for any JSON data containing posts
    const scripts = $('script:not([src])');
    let postsFound = 0;
    
    scripts.each((i, script) => {
        const content = $(script).html();
        if (!content) return;
        
        // Debug: Count potential data indicators
        const hasShortcode = content.includes('shortcode');
        const hasTimeline = content.includes('timeline');
        const hasEdges = content.includes('edges');
        const hasNode = content.includes('node');
        
        if (hasShortcode && (hasTimeline || hasEdges || hasNode)) {
            console.log(`   Script ${i}: Contains post-like data (shortcode + structure)`);
            
            // Try to extract shortcodes directly without complex JSON parsing
            const shortcodeMatches = content.match(/"shortcode":\s*"([A-Za-z0-9_-]+)"/g);
            if (shortcodeMatches) {
                console.log(`   Found ${shortcodeMatches.length} shortcode matches`);
                postsFound += shortcodeMatches.length;
                
                // Extract unique shortcodes
                const shortcodes = shortcodeMatches
                    .map(match => match.match(/"shortcode":\s*"([A-Za-z0-9_-]+)"/)[1])
                    .filter((code, index, arr) => arr.indexOf(code) === index);
                
                if (shortcodes.length > 0) {
                    console.log(`✅ Extracted ${shortcodes.length} unique shortcodes`);
                    
                    // Convert to post URLs
                    const postUrls = shortcodes.slice(0, maxPostsPerProfile).map(shortcode => {
                        return `https://www.instagram.com/p/${shortcode}/`;
                    });
                    
                    return { 
                        postUrls, 
                        username: userData.username,
                        strategy: userData.strategy,
                        extractedFrom: `script-${i}`
                    };
                }
            }
        }
    });
    
    console.log(`📊 Total potential posts found: ${postsFound}`);
    
    // Method 2: If JSON approach fails, try URL scanning
    if (postsFound === 0) {
        console.log('🔍 Trying URL pattern scanning...');
        
        // Look for Instagram post URLs anywhere in the HTML
        const postUrlPattern = /instagram\.com\/p\/([A-Za-z0-9_-]+)/g;
        const urlMatches = [...html.matchAll(postUrlPattern)];
        
        if (urlMatches.length > 0) {
            const shortcodes = [...new Set(urlMatches.map(match => match[1]))];
            const postUrls = shortcodes.slice(0, maxPostsPerProfile).map(shortcode => 
                `https://www.instagram.com/p/${shortcode}/`
            );
            
            console.log(`✅ Found ${postUrls.length} posts via URL scanning`);
            return { 
                postUrls, 
                username: userData.username,
                strategy: userData.strategy,
                extractedFrom: 'url-scan'
            };
        }
    }
    
    // Method 3: Try to find ANY structured data about posts
    console.log('🔍 Looking for any post references...');
    
    // Look for any mention of posts in a structured format
    const postIndicators = [
        /"display_url":/,
        /"thumbnail_src":/,
        /"taken_at_timestamp":/,
        /"edge_media_to_comment":/,
        /"edge_liked_by":/
    ];
    
    let foundStructuredData = false;
    scripts.each((i, script) => {
        const content = $(script).html();
        if (!content) return;
        
        const indicatorCount = postIndicators.reduce((count, pattern) => {
            return count + (pattern.test(content) ? 1 : 0);
        }, 0);
        
        if (indicatorCount >= 3) {
            console.log(`   Script ${i}: Contains ${indicatorCount}/5 post indicators`);
            foundStructuredData = true;
            
            // Even if we can't parse the JSON, we know posts exist
            // This suggests Instagram is hiding the data from us
        }
    });
    
    if (foundStructuredData) {
        console.log('⚠️ Found structured post data but cannot extract URLs');
        console.log('   This suggests Instagram is blocking data extraction');
    }
    
    console.log('❌ No extractable post data found');
    return null;
};

// Enhanced post data extraction
const extractPostData = ($, html, url) => {
    const shortcode = url.split('/p/')[1]?.split('/')[0];
    if (!shortcode) return null;
    
    const post = {
        url,
        shortcode,
        type: 'post',
        caption: '',
        images: [],
        videos: [],
        likesCount: 0,
        commentsCount: 0,
        timestamp: '',
        ownerUsername: '',
        hashtags: [],
        mentions: []
    };
    
    // Try to extract from meta tags (often more reliable for posts)
    const ogDescription = $('meta[property="og:description"]').attr('content');
    if (ogDescription) {
        post.caption = ogDescription;
    }
    
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
        post.images.push({
            url: ogImage,
            width: 0,
            height: 0,
            source: 'og-meta'
        });
    }
    
    // Extract engagement from page text
    const pageText = $.text();
    const likeMatch = pageText.match(/(\d+(?:,\d+)*)\s*likes?/i);
    if (likeMatch) {
        post.likesCount = parseInt(likeMatch[1].replace(/,/g, ''));
    }
    
    const commentMatch = pageText.match(/(\d+(?:,\d+)*)\s*comments?/i);
    if (commentMatch) {
        post.commentsCount = parseInt(commentMatch[1].replace(/,/g, ''));
    }
    
    // Extract hashtags and mentions
    if (post.caption) {
        post.hashtags = [...new Set((post.caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
        post.mentions = [...new Set((post.caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
    }
    
    console.log(`✅ Extracted post data: ${post.caption ? 'caption' : 'no caption'}, ${post.images.length} images, ${post.likesCount} likes`);
    
    return post;
};

// Create proxy configuration
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// Enhanced crawler with better headers and session management
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    requestHandlerTimeoutSecs,
    maxConcurrency,
    
    // Better session management
    sessionPoolOptions: {
        maxPoolSize: 20,
        sessionOptions: {
            maxUsageCount: 3, // Use each session only 3 times
            maxErrorScore: 1, // Retire after just 1 error
        }
    },
    
    preNavigationHooks: [
        async (crawlingContext) => {
            const { request, session } = crawlingContext;
            
            // Add delay
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
            
            // Rotate headers based on strategy
            const userData = request.userData || {};
            const isMobile = userData.strategy === 'mobile';
            
            request.headers = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'User-Agent': isMobile 
                    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
                    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'DNT': '1',
                'Connection': 'keep-alive'
            };
            
            console.log(`🌐 ${userData.strategy || 'unknown'} request to: ${request.url}`);
        }
    ],
    
    async requestHandler({ $, body, request, log, session }) {
        const url = request.url;
        const userData = request.userData || {};
        
        log.info(`🔄 Processing: ${url}`);
        log.info(`   Strategy: ${userData.strategy}`);
        log.info(`   Session: ${session?.id}`);
        
        try {
            // Check for blocking
            const title = $('title').text().toLowerCase();
            if (title.includes('login') || title.includes('please wait') || title.includes('error')) {
                log.warning(`🚫 Blocked or redirected: ${title}`);
                session?.retire();
                throw new Error('Instagram blocking detected');
            }
            
            if (url.includes('/p/')) {
                // Handle individual post
                const postData = extractPostData($, body, url);
                
                if (postData) {
                    // Apply filters
                    if (!includeHashtags) delete postData.hashtags;
                    if (!includeMentions) delete postData.mentions;
                    if (!includeEngagementMetrics) {
                        delete postData.likesCount;
                        delete postData.commentsCount;
                    }
                    
                    postData.scrapedAt = new Date().toISOString();
                    
                    await dataset.pushData(postData);
                    log.info(`✅ Saved post: ${url}`);
                } else {
                    log.warning(`❌ No post data: ${url}`);
                }
            } else {
                // Handle profile page
                const result = parseInstagramHTML(body, url, userData);
                
                if (result && result.postUrls && result.postUrls.length > 0) {
                    log.info(`🎯 Found ${result.postUrls.length} posts via ${result.strategy} (${result.extractedFrom})`);
                    
                    // Add post URLs to queue
                    const postRequests = result.postUrls.map(postUrl => ({ url: postUrl }));
                    await crawler.addRequests(postRequests);
                    
                    // Mark this username as processed to avoid duplicates
                    global.processedUsernames = global.processedUsernames || new Set();
                    global.processedUsernames.add(userData.username);
                    
                } else {
                    log.warning(`❌ No posts found for ${userData.username} via ${userData.strategy}`);
                    
                    // If this was the basic profile strategy, try other strategies
                    if (userData.strategy === 'profile') {
                        log.info(`🔄 Trying alternative strategies for ${userData.username}...`);
                        
                        // Only try alternatives if we haven't processed this username yet
                        global.processedUsernames = global.processedUsernames || new Set();
                        if (!global.processedUsernames.has(userData.username)) {
                            await extractInstagramDataDirect(crawler, userData.username);
                        }
                    }
                }
            }
        } catch (error) {
            log.error(`💥 Error: ${error.message}`);
            if (error.message.includes('blocking')) {
                session?.retire();
                throw error;
            }
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.error(`💀 Request failed: ${request.url}`);
    }
});

// Initialize processing
console.log(`🚀 Starting Instagram scraper with enhanced strategies`);
console.log(`📋 Targets: ${usernames.length} usernames, ${postUrls.length} direct URLs`);

// Add username requests using the direct extraction approach
for (const username of usernames) {
    if (username.trim()) {
        await extractInstagramDataDirect(crawler, username.trim());
    }
}

// Add direct post URLs
for (const postUrl of postUrls) {
    if (postUrl.trim() && postUrl.includes('/p/')) {
        await crawler.addRequests([{ url: postUrl.trim() }]);
    }
}

// Start crawling
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`🎉 Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();