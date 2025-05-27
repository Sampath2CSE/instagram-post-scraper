// main.js - Advanced Instagram Scraper (Anti-Detection 2025)
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
    maxRequestRetries = 2,
    requestHandlerTimeoutSecs = 30,
    maxConcurrency = 1, // Very low to avoid detection
    dateFrom,
    dateTo
} = input;

const dataset = await Dataset.open();

// Generate random delays to mimic human behavior
const randomDelay = () => Math.floor(Math.random() * 3000) + 1000;

// User agents pool for rotation
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

// Try multiple strategies to extract Instagram data
const extractInstagramData = (html, url) => {
    try {
        console.log(`Extracting data from: ${url}`);
        
        const $ = cheerio.load(html);
        const isProfileUrl = !url.includes('/p/') && !url.includes('/reel/');
        
        if (isProfileUrl) {
            return extractProfileDataFixed($, html, url);
        } else {
            return extractPostDataAdvanced($, html, url);
        }
    } catch (error) {
        console.log(`Error extracting data from ${url}:`, error.message);
        return null;
    }
};

// Simplified and more robust profile data extraction
const extractProfileDataFixed = ($, html, url) => {
    console.log('Starting simplified profile data extraction...');
    
    let postUrls = [];
    
    // Strategy 1: Look for shortcode references anywhere in HTML
    console.log('Strategy 1: Looking for shortcode patterns...');
    const shortcodePattern = /"shortcode":"([A-Za-z0-9_-]+)"/g;
    const shortcodeMatches = [...html.matchAll(shortcodePattern)];
    
    if (shortcodeMatches.length > 0) {
        const uniqueShortcodes = [...new Set(shortcodeMatches.map(match => match[1]))];
        postUrls = uniqueShortcodes.slice(0, maxPostsPerProfile).map(shortcode => 
            `https://www.instagram.com/p/${shortcode}/`
        );
        console.log(`Found ${postUrls.length} posts from shortcode pattern matching`);
        return { postUrls, profileData: null };
    }
    
    // Strategy 2: Look for the classic window._sharedData with safer parsing
    console.log('Strategy 2: Looking for window._sharedData...');
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});/);
    if (sharedDataMatch) {
        try {
            const sharedData = JSON.parse(sharedDataMatch[1]);
            const user = sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user;
            
            if (user?.edge_owner_to_timeline_media?.edges) {
                const edges = user.edge_owner_to_timeline_media.edges;
                postUrls = edges.slice(0, maxPostsPerProfile).map(edge => {
                    const shortcode = edge.node.shortcode;
                    const isReel = edge.node.__typename === 'GraphVideo' && 
                                  edge.node.product_type === 'clips';
                    return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
                });
                console.log(`Found ${postUrls.length} posts from window._sharedData`);
                return { postUrls, profileData: user };
            }
        } catch (parseError) {
            console.log('Failed to parse window._sharedData:', parseError.message);
        }
    }
    
    // Strategy 3: Look for any GraphQL user data with timeline
    console.log('Strategy 3: Looking for GraphQL user data...');
    const userDataPattern = /"user":\s*({[^}]*"edge_owner_to_timeline_media"[^}]*}[^}]*})/;
    const userDataMatch = html.match(userDataPattern);
    if (userDataMatch) {
        try {
            // Try to extract just the user object safely
            const userStr = userDataMatch[1];
            // Find the end of the user object by counting braces
            let braceCount = 0;
            let endIndex = 0;
            for (let i = 0; i < userStr.length; i++) {
                if (userStr[i] === '{') braceCount++;
                if (userStr[i] === '}') braceCount--;
                if (braceCount === 0) {
                    endIndex = i + 1;
                    break;
                }
            }
            
            const cleanUserStr = userStr.substring(0, endIndex);
            const userData = JSON.parse(cleanUserStr);
            
            if (userData?.edge_owner_to_timeline_media?.edges) {
                const edges = userData.edge_owner_to_timeline_media.edges;
                postUrls = edges.slice(0, maxPostsPerProfile).map(edge => {
                    const shortcode = edge.node.shortcode;
                    const isReel = edge.node.__typename === 'GraphVideo' && 
                                  edge.node.product_type === 'clips';
                    return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
                });
                console.log(`Found ${postUrls.length} posts from GraphQL user data`);
                return { postUrls, profileData: userData };
            }
        } catch (parseError) {
            console.log('Failed to parse GraphQL user data:', parseError.message);
        }
    }
    
    // Strategy 4: Simple URL pattern matching in HTML
    console.log('Strategy 4: Looking for Instagram URL patterns...');
    const urlPattern = /instagram\.com\/p\/([A-Za-z0-9_-]+)/g;
    const urlMatches = [...html.matchAll(urlPattern)];
    
    if (urlMatches.length > 0) {
        const uniqueShortcodes = [...new Set(urlMatches.map(match => match[1]))];
        postUrls = uniqueShortcodes.slice(0, maxPostsPerProfile).map(shortcode => 
            `https://www.instagram.com/p/${shortcode}/`
        );
        console.log(`Found ${postUrls.length} posts from URL pattern matching`);
        return { postUrls, profileData: null };
    }
    
    // Strategy 5: Look for any post-like structures in script tags
    console.log('Strategy 5: Scanning script tags for post data...');
    const scripts = $('script:not([src])');
    
    scripts.each((i, script) => {
        const content = $(script).html();
        if (!content) return;
        
        // Look for any mention of shortcodes in a structured way
        const timelinePattern = /"edges":\s*\[\s*{[^}]*"shortcode"/;
        if (timelinePattern.test(content)) {
            console.log(`Script ${i}: Found timeline-like structure`);
            
            // Extract all shortcodes from this script
            const scriptShortcodes = [...content.matchAll(/"shortcode":"([A-Za-z0-9_-]+)"/g)];
            if (scriptShortcodes.length > 0) {
                const uniqueShortcodes = [...new Set(scriptShortcodes.map(match => match[1]))];
                postUrls = uniqueShortcodes.slice(0, maxPostsPerProfile).map(shortcode => 
                    `https://www.instagram.com/p/${shortcode}/`
                );
                console.log(`Found ${postUrls.length} posts from script ${i}`);
                return false; // Break the loop
            }
        }
    });
    
    if (postUrls.length > 0) {
        return { postUrls, profileData: null };
    }
    
    console.log('All extraction strategies failed');
    return { postUrls: [], profileData: null };
};

// Helper function to recursively search for user data in any object
const extractUserDataFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    
    // Direct match
    if (obj.edge_owner_to_timeline_media) {
        return obj;
    }
    
    // Check nested objects
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            
            if (value && typeof value === 'object') {
                // Check if this is user data
                if (key === 'user' && value.edge_owner_to_timeline_media) {
                    return value;
                }
                
                // Check if this is nested ProfilePage data
                if (key === 'ProfilePage' && Array.isArray(value) && value[0]?.graphql?.user) {
                    return value[0].graphql.user;
                }
                
                // Recursive search
                const found = extractUserDataFromObject(value);
                if (found) return found;
            }
        }
    }
    
    return null;
};

// Advanced post data extraction
const extractPostDataAdvanced = ($, html, url) => {
    console.log('Extracting post data with advanced methods...');
    
    const isReel = url.includes('/reel/');
    const shortcode = isReel ? 
        url.split('/reel/')[1]?.split('/')[0] : 
        url.split('/p/')[1]?.split('/')[0];
    
    if (!shortcode) {
        throw new Error('Could not extract shortcode from URL');
    }
    
    const post = {
        url,
        shortcode,
        isReel,
        type: isReel ? 'reel' : 'image',
        images: [],
        videos: [],
        hashtags: [],
        mentions: [],
        likesCount: 0,
        commentsCount: 0,
        viewCount: 0,
        caption: '',
        ownerUsername: '',
        timestamp: '',
        locationName: '',
        locationId: '',
        comments: []
    };
    
    // Extract owner username from URL
    const urlParts = url.split('/').filter(p => p && p !== 'www.instagram.com' && p !== 'https:');
    if (urlParts.length > 0) {
        post.ownerUsername = urlParts[0] || '';
    }
    
    // Try multiple extraction methods for post data
    const extractionMethods = [
        () => extractFromScriptTags($, html, post),
        () => extractFromMetaTags($, post),
        () => extractFromDOM($, post),
        () => extractFromPageText($, post, isReel)
    ];
    
    for (const method of extractionMethods) {
        try {
            const result = method();
            if (result) {
                Object.assign(post, result);
                break;
            }
        } catch (error) {
            console.log('Extraction method failed:', error.message);
            continue;
        }
    }
    
    // Extract hashtags and mentions from caption
    if (post.caption) {
        post.hashtags = [...new Set((post.caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
        post.mentions = [...new Set((post.caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
    }
    
    // Determine post type
    if (isReel) {
        post.type = 'reel';
    } else if (post.videos.length > 0) {
        post.type = post.videos.length === 1 ? 'video' : 'carousel_video';
    } else if (post.images.length > 1) {
        post.type = 'carousel_album';
    } else {
        post.type = 'image';
    }
    
    return post;
};

// Extract post data from script tags
const extractFromScriptTags = ($, html, post) => {
    const scripts = $('script:not([src])');
    
    scripts.each((i, script) => {
        const content = $(script).html();
        if (!content) return;
        
        const patterns = [
            /"shortcode_media":\s*({.+?})/,
            /"PostPage"[^{]*"shortcode_media":\s*({.+?})/,
            /"data":\s*{"shortcode_media":\s*({.+?})}/
        ];
        
        for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match) {
                try {
                    const data = JSON.parse(match[1]);
                    
                    if (data.edge_media_to_caption?.edges?.[0]?.node?.text) {
                        post.caption = data.edge_media_to_caption.edges[0].node.text;
                    }
                    
                    post.likesCount = data.edge_media_preview_like?.count || 0;
                    post.commentsCount = data.edge_media_to_parent_comment?.count || 0;
                    post.viewCount = data.video_view_count || 0;
                    
                    if (data.taken_at_timestamp) {
                        post.timestamp = new Date(data.taken_at_timestamp * 1000).toISOString();
                    }
                    
                    if (data.owner?.username) {
                        post.ownerUsername = data.owner.username;
                    }
                    
                    if (data.location) {
                        post.locationName = data.location.name || '';
                        post.locationId = data.location.id || '';
                    }
                    
                    if (data.display_url) {
                        post.images.push({
                            url: data.display_url,
                            width: data.dimensions?.width || 0,
                            height: data.dimensions?.height || 0,
                            source: 'json'
                        });
                    }
                    
                    if (data.video_url) {
                        post.videos.push({
                            url: data.video_url,
                            width: data.dimensions?.width || 0,
                            height: data.dimensions?.height || 0,
                            source: 'json'
                        });
                    }
                    
                    return post;
                } catch (parseError) {
                    continue;
                }
            }
        }
    });
    
    return null;
};

// Extract from meta tags
const extractFromMetaTags = ($, post) => {
    const metaDesc = $('meta[property="og:description"]').attr('content');
    if (metaDesc && metaDesc.length > 20) {
        let desc = metaDesc;
        desc = desc.replace(/^\d+[KMB]?\s*(likes?|comments?)[^"]*?"\s*-\s*[^"]*?\s*on\s*[^:]*?:\s*"?/, '');
        desc = desc.replace(/"\s*$/, '');
        if (desc.length > 10) {
            post.caption = desc;
            return post;
        }
    }
    return null;
};

// Extract from DOM elements
const extractFromDOM = ($, post) => {
    $('img[src]').each((i, img) => {
        const src = $(img).attr('src');
        if (src && (src.includes('scontent') || src.includes('cdninstagram')) &&
            !src.includes('profile') && !src.includes('s150x150')) {
            post.images.push({
                url: src,
                width: parseInt($(img).attr('width')) || 0,
                height: parseInt($(img).attr('height')) || 0,
                source: 'dom'
            });
        }
    });
    
    $('video[src], video source[src]').each((i, video) => {
        const src = $(video).attr('src');
        if (src && !src.startsWith('blob:')) {
            post.videos.push({
                url: src,
                width: 0,
                height: 0,
                source: 'dom'
            });
        }
    });
    
    return post.images.length > 0 || post.videos.length > 0 ? post : null;
};

// Extract engagement from page text
const extractFromPageText = ($, post, isReel) => {
    const pageText = $.text();
    
    const likeMatches = pageText.match(/(\d+(?:,\d+)*)\s*likes?/i);
    if (likeMatches) {
        post.likesCount = parseInt(likeMatches[1].replace(/,/g, ''));
    }
    
    const commentMatches = pageText.match(/(\d+(?:,\d+)*)\s*comments?/i);
    if (commentMatches) {
        post.commentsCount = parseInt(commentMatches[1].replace(/,/g, ''));
    }
    
    if (isReel) {
        const viewMatches = pageText.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*views?/i);
        if (viewMatches) {
            let views = viewMatches[1].replace(/,/g, '');
            if (views.includes('K')) {
                post.viewCount = Math.floor(parseFloat(views) * 1000);
            } else if (views.includes('M')) {
                post.viewCount = Math.floor(parseFloat(views) * 1000000);
            } else if (views.includes('B')) {
                post.viewCount = Math.floor(parseFloat(views) * 1000000000);
            } else {
                post.viewCount = parseInt(views) || 0;
            }
        }
    }
    
    return post.likesCount > 0 || post.commentsCount > 0 || post.viewCount > 0 ? post : null;
};

// Create proxy configuration
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// Main crawler configuration with enhanced anti-detection
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    requestHandlerTimeoutSecs,
    maxConcurrency,
    
    // Advanced session handling
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 5, // Use each session max 5 times
            maxErrorScore: 3, // Retire session after 3 errors
        }
    },
    
    // Set headers using preNavigationHooks with rotation
    preNavigationHooks: [
        async (crawlingContext) => {
            const { request } = crawlingContext;
            
            // Add random delay between requests
            await new Promise(resolve => setTimeout(resolve, randomDelay()));
            
            // Rotate user agent
            const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            
            // Set realistic headers
            request.headers = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'User-Agent': userAgent,
                'Dnt': '1',
                'Connection': 'keep-alive'
            };
            
            console.log(`Using User-Agent: ${userAgent.substring(0, 50)}...`);
        }
    ],
    
    async requestHandler({ $, body, request, log, session }) {
        const url = request.url;
        log.info(`Processing: ${url}`);
        
        try {
            // Debug info
            log.info(`Response size: ${body.length} bytes`);
            log.info(`Session ID: ${session?.id}`);
            log.info(`Page title: ${$('title').text()}`);
            
            // Enhanced blocking detection
            const blockingIndicators = [
                'Please wait a few minutes before you try again',
                'Sorry, something went wrong',
                'login_required',
                'challenge_required',
                'We restrict certain content',
                'This content isn\'t available',
                'checkpoint_required'
            ];
            
            const isBlocked = blockingIndicators.some(indicator => 
                body.toLowerCase().includes(indicator.toLowerCase())
            );
            
            if (isBlocked || $('title').text().toLowerCase().includes('login')) {
                log.warning('🚫 Instagram blocking detected - rotating session');
                session?.retire();
                throw new Error('Instagram blocking detected');
            }
            
            // Check for empty/minimal response
            if (body.length < 5000) {
                log.warning('⚠️ Suspiciously small response - possible blocking');
            }
            
            if (url.includes('/p/') || url.includes('/reel/')) {
                // Handle individual post or reel
                const postData = extractInstagramData(body, url);
                
                if (postData && postData.url) {
                    // Apply filters
                    if (dateFrom || dateTo) {
                        const postDate = new Date(postData.timestamp);
                        if (dateFrom && postDate < new Date(dateFrom)) return;
                        if (dateTo && postDate > new Date(dateTo)) return;
                    }
                    
                    // Apply user preferences
                    if (!includeHashtags) delete postData.hashtags;
                    if (!includeMentions) delete postData.mentions;
                    if (!includeLocation) {
                        delete postData.locationName;
                        delete postData.locationId;
                    }
                    if (!includeEngagementMetrics) {
                        delete postData.likesCount;
                        delete postData.commentsCount;
                        delete postData.viewCount;
                    }
                    
                    postData.scrapedAt = new Date().toISOString();
                    
                    await dataset.pushData(postData);
                    log.info(`✅ Successfully scraped ${postData.isReel ? 'reel' : 'post'}: ${url}`);
                } else {
                    log.warning(`❌ No post data extracted from: ${url}`);
                }
            } else {
                // Handle profile page
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const result = extractInstagramData(body, url);
                
                if (result && result.postUrls && result.postUrls.length > 0) {
                    const postUrls = result.postUrls.slice(0, maxPostsPerProfile);
                    log.info(`🎯 Found ${postUrls.length} posts for ${username}`);
                    
                    // Add requests with delays
                    for (let i = 0; i < postUrls.length; i++) {
                        await crawler.addRequests([{ url: postUrls[i] }]);
                        
                        // Add delay every 5 requests
                        if (i > 0 && i % 5 === 0) {
                            await new Promise(resolve => setTimeout(resolve, randomDelay()));
                        }
                    }
                } else {
                    log.warning(`❌ No posts found for ${username}`);
                    log.info('🔍 Debug info:');
                    log.info(`   - HTML size: ${body.length} bytes`);
                    log.info(`   - Contains ProfilePage: ${body.includes('ProfilePage')}`);
                    log.info(`   - Contains timeline_media: ${body.includes('timeline_media')}`);
                    log.info(`   - Contains shortcode: ${body.includes('shortcode')}`);
                    log.info(`   - Total links: ${$('a').length}`);
                }
            }
        } catch (error) {
            log.error(`💥 Error processing ${url}:`, error.message);
            
            // Retry with new session if blocked
            if (error.message.includes('blocking')) {
                session?.retire();
                throw error; // This will trigger a retry
            }
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.error(`💀 Request failed permanently: ${request.url}`);
    }
});

// Add initial requests
const initialRequests = [];

for (const username of usernames) {
    if (username.trim()) {
        initialRequests.push({ url: `https://www.instagram.com/${username.trim()}/` });
    }
}

for (const contentUrl of postUrls) {
    if (contentUrl.trim() && (contentUrl.includes('/p/') || contentUrl.includes('/reel/'))) {
        initialRequests.push({ url: contentUrl.trim() });
    }
}

if (initialRequests.length === 0) {
    throw new Error('No valid usernames or post URLs provided');
}

console.log(`🚀 Starting advanced scraper with ${initialRequests.length} initial requests`);
console.log(`🔧 Configuration: ${maxConcurrency} concurrency, ${maxRequestRetries} retries`);

await crawler.addRequests(initialRequests);
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`🎉 Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();