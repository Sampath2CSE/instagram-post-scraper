// main.js - Instagram Post Scraper (Updated 2025 Version)
import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { chromium } from 'playwright';

await Actor.init();

// Get input from the user
const input = await Actor.getInput();

// Validate required input
if (!input || (!input.usernames && !input.postUrls)) {
    throw new Error('Missing required input: Please provide either usernames or postUrls');
}

// Configuration with defaults
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
    requestHandlerTimeoutSecs = 45,
    maxConcurrency = 2, // Reduced for better success rate
    dateFrom,
    dateTo
} = input;

// Initialize dataset for storing results
const dataset = await Dataset.open();

// Helper function to wait with random human-like delays
const humanDelay = async (min = 2000, max = 5000) => {
    const delay = Math.floor(Math.random() * (max - min) + min);
    await new Promise(resolve => setTimeout(resolve, delay));
};

// Helper function to extract data using Instagram's internal API data
const extractPostData = async (page, contentUrl) => {
    try {
        console.log(`Extracting data for: ${contentUrl}`);
        
        // Set realistic viewport
        await page.setViewportSize({ width: 1366, height: 768 });
        
        // Navigate to the post
        await page.goto(contentUrl, { 
            waitUntil: 'networkidle',
            timeout: 30000 
        });
        
        // Wait for content to load
        await humanDelay(3000, 6000);
        
        // Scroll slightly to trigger any lazy loading
        await page.evaluate(() => {
            window.scrollBy(0, Math.random() * 300);
        });
        
        await humanDelay(1000, 2000);
        
        const isReel = contentUrl.includes('/reel/');
        
        // Extract data by finding Instagram's JSON-LD or internal data
        const postData = await page.evaluate(async ({ url, isReel }) => {
            const post = {
                url,
                isReel,
                shortcode: isReel ? url.split('/reel/')[1]?.split('/')[0] : url.split('/p/')[1]?.split('/')[0],
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
                locationId: ''
            };
            
            // Extract owner username from URL (most reliable)
            const urlParts = url.split('/').filter(p => p);
            for (let i = 0; i < urlParts.length; i++) {
                if ((urlParts[i] === 'p' || urlParts[i] === 'reel') && i > 0) {
                    post.ownerUsername = urlParts[i - 1];
                    break;
                }
            }
            
            console.log('Starting Instagram data extraction...');
            
            // Method 1: Try to find Instagram's GraphQL data (most reliable)
            let foundData = false;
            const scripts = document.querySelectorAll('script:not([src])');
            
            console.log(`Found ${scripts.length} script tags to analyze`);
            
            for (let i = 0; i < scripts.length; i++) {
                const script = scripts[i];
                const content = script.textContent || '';
                
                if (!content || content.length < 100) continue;
                
                // Look for various Instagram data patterns
                const patterns = [
                    // Pattern 1: Direct shortcode_media in GraphQL response
                    /"shortcode_media":\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})/,
                    // Pattern 2: Data with shortcode_media wrapper
                    /\{"data":\s*\{"shortcode_media":\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})\}/,
                    // Pattern 3: Alternative GraphQL format
                    /"graphql":\s*\{"shortcode_media":\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})\}/
                ];
                
                for (const pattern of patterns) {
                    const match = content.match(pattern);
                    if (match) {
                        try {
                            const mediaData = JSON.parse(match[1]);
                            console.log('Found Instagram GraphQL data');
                            
                            // Extract caption
                            if (mediaData.edge_media_to_caption?.edges?.[0]?.node?.text) {
                                post.caption = mediaData.edge_media_to_caption.edges[0].node.text;
                            }
                            
                            // Extract engagement
                            if (mediaData.edge_media_preview_like?.count !== undefined) {
                                post.likesCount = mediaData.edge_media_preview_like.count;
                            }
                            if (mediaData.edge_media_to_parent_comment?.count !== undefined) {
                                post.commentsCount = mediaData.edge_media_to_parent_comment.count;
                            }
                            if (mediaData.video_view_count !== undefined) {
                                post.viewCount = mediaData.video_view_count;
                            }
                            
                            // Extract timestamp
                            if (mediaData.taken_at_timestamp) {
                                post.timestamp = new Date(mediaData.taken_at_timestamp * 1000).toISOString();
                            }
                            
                            // Extract owner info
                            if (mediaData.owner?.username) {
                                post.ownerUsername = mediaData.owner.username;
                            }
                            
                            // Extract location
                            if (mediaData.location?.name) {
                                post.locationName = mediaData.location.name;
                                post.locationId = mediaData.location.id || '';
                            }
                            
                            // Extract media URLs
                            if (mediaData.display_url) {
                                post.images.push({
                                    url: mediaData.display_url,
                                    width: mediaData.dimensions?.width || 0,
                                    height: mediaData.dimensions?.height || 0,
                                    source: 'graphql'
                                });
                            }
                            
                            if (mediaData.video_url) {
                                post.videos.push({
                                    url: mediaData.video_url,
                                    width: mediaData.dimensions?.width || 0,
                                    height: mediaData.dimensions?.height || 0,
                                    source: 'graphql'
                                });
                            }
                            
                            // Handle carousel posts
                            if (mediaData.edge_sidecar_to_children?.edges) {
                                post.images = []; // Reset images for carousel
                                post.videos = []; // Reset videos for carousel
                                
                                for (const edge of mediaData.edge_sidecar_to_children.edges) {
                                    const node = edge.node;
                                    if (node.display_url) {
                                        post.images.push({
                                            url: node.display_url,
                                            width: node.dimensions?.width || 0,
                                            height: node.dimensions?.height || 0,
                                            source: 'carousel'
                                        });
                                    }
                                    if (node.video_url) {
                                        post.videos.push({
                                            url: node.video_url,
                                            width: node.dimensions?.width || 0,
                                            height: node.dimensions?.height || 0,
                                            source: 'carousel'
                                        });
                                    }
                                }
                            }
                            
                            foundData = true;
                            console.log('Successfully extracted from GraphQL data');
                            break;
                        } catch (e) {
                            console.log(`Parse error in script ${i}:`, e.message);
                            continue;
                        }
                    }
                }
                
                if (foundData) break;
            }
            
            // Method 2: Enhanced meta tag extraction
            if (!foundData || !post.caption) {
                console.log('Trying meta tag extraction...');
                
                const metaDesc = document.querySelector('meta[property="og:description"]');
                const metaTitle = document.querySelector('meta[property="og:title"]');
                
                if (metaDesc?.content) {
                    let content = metaDesc.content;
                    
                    // More robust caption cleaning
                    content = content.replace(/^\d+[KMB]?\s*(likes?|followers?|following)[^"]*"\s*-\s*/, '');
                    content = content.replace(/^.*?"\s*-\s*/, '');
                    content = content.replace(/\s*on Instagram[^"]*$/, '');
                    content = content.replace(/"\s*$/, '');
                    
                    if (content.length > 10 && !post.caption) {
                        post.caption = content.trim();
                        console.log('Extracted caption from meta description');
                    }
                }
                
                // Extract username from title if not found
                if (!post.ownerUsername && metaTitle?.content) {
                    const titleMatch = metaTitle.content.match(/^([^()]+)\s*\(/);
                    if (titleMatch) {
                        const extractedName = titleMatch[1].trim();
                        if (extractedName.startsWith('@')) {
                            post.ownerUsername = extractedName.substring(1);
                        }
                    }
                }
            }
            
            // Method 3: Enhanced engagement extraction from page elements
            if (!foundData) {
                console.log('Trying DOM engagement extraction...');
                
                // Look for engagement in aria-labels and button text
                const engagementElements = document.querySelectorAll([
                    'button[aria-label*="like"]',
                    'button[aria-label*="comment"]', 
                    'span[aria-label*="like"]',
                    'span[aria-label*="comment"]',
                    'a[aria-label*="like"]',
                    'a[aria-label*="comment"]',
                    'section span',
                    'article span'
                ].join(', '));
                
                for (const element of engagementElements) {
                    const ariaLabel = element.getAttribute('aria-label') || '';
                    const text = element.textContent || '';
                    const fullText = (ariaLabel + ' ' + text).toLowerCase();
                    
                    // Extract likes with more patterns
                    if (post.likesCount === 0) {
                        const likePatterns = [
                            /(\d+(?:,\d+)*)\s*likes?/,
                            /liked\s+by\s+(\d+(?:,\d+)*)/,
                            /(\d+(?:,\d+)*)\s*others?/
                        ];
                        
                        for (const pattern of likePatterns) {
                            const match = fullText.match(pattern);
                            if (match) {
                                post.likesCount = parseInt(match[1].replace(/,/g, ''));
                                break;
                            }
                        }
                    }
                    
                    // Extract comments
                    if (post.commentsCount === 0) {
                        const commentMatch = fullText.match(/(\d+(?:,\d+)*)\s*comments?/);
                        if (commentMatch) {
                            post.commentsCount = parseInt(commentMatch[1].replace(/,/g, ''));
                        }
                    }
                    
                    // Extract views for reels with number formatting
                    if (isReel && post.viewCount === 0) {
                        const viewPatterns = [
                            /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*views?/,
                            /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*plays?/
                        ];
                        
                        for (const pattern of viewPatterns) {
                            const match = fullText.match(pattern);
                            if (match) {
                                let views = match[1].replace(/,/g, '');
                                
                                if (views.includes('K')) {
                                    post.viewCount = Math.floor(parseFloat(views) * 1000);
                                } else if (views.includes('M')) {
                                    post.viewCount = Math.floor(parseFloat(views) * 1000000);
                                } else if (views.includes('B')) {
                                    post.viewCount = Math.floor(parseFloat(views) * 1000000000);
                                } else {
                                    const numViews = parseInt(views);
                                    if (numViews > 100) {
                                        post.viewCount = numViews;
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
            
            // Method 4: Enhanced media extraction with better selectors
            if (post.images.length === 0 && post.videos.length === 0) {
                console.log('Trying media extraction...');
                
                // More specific selectors for Instagram content
                const mediaContainers = document.querySelectorAll([
                    'main article',
                    'article[role="presentation"]',
                    'div[role="presentation"]',
                    'main div'
                ].join(', '));
                
                for (const container of mediaContainers) {
                    // Extract images
                    const images = container.querySelectorAll('img[src]');
                    for (const img of images) {
                        if (img.src && 
                            (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                            !img.src.includes('profile') &&
                            !img.src.includes('s150x150') &&
                            !img.src.includes('avatar') &&
                            img.naturalWidth > 200) {
                            
                            post.images.push({
                                url: img.src,
                                width: img.naturalWidth || 0,
                                height: img.naturalHeight || 0,
                                source: 'dom'
                            });
                        }
                    }
                    
                    // Extract videos
                    const videos = container.querySelectorAll('video[src], video source[src]');
                    for (const video of videos) {
                        const videoUrl = video.src || video.getAttribute('src');
                        if (videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:')) {
                            post.videos.push({
                                url: videoUrl,
                                width: video.videoWidth || 0,
                                height: video.videoHeight || 0,
                                source: 'dom'
                            });
                        }
                    }
                    
                    // If we found media, break
                    if (post.images.length > 0 || post.videos.length > 0) {
                        break;
                    }
                }
            }
            
            // Extract hashtags and mentions from caption
            if (post.caption) {
                post.hashtags = [...new Set((post.caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
                post.mentions = [...new Set((post.caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
            }
            
            // Determine post type more accurately
            if (isReel) {
                post.type = 'reel';
            } else if (post.videos.length > 0) {
                post.type = post.videos.length === 1 ? 'video' : 'carousel_video';
            } else if (post.images.length > 1) {
                post.type = 'carousel_album';
            } else {
                post.type = 'image';
            }
            
            console.log('Final extraction results:', {
                caption: !!post.caption,
                images: post.images.length,
                videos: post.videos.length,
                likes: post.likesCount,
                comments: post.commentsCount,
                views: post.viewCount
            });
            
            return post;
        }, { url: contentUrl, isReel });
        
        console.log(`Extraction completed for ${contentUrl}:`);
        console.log(`- Caption: ${postData.caption ? 'Found' : 'Not found'}`);
        console.log(`- Media: ${postData.images.length} images, ${postData.videos.length} videos`);
        console.log(`- Engagement: ${postData.likesCount} likes, ${postData.commentsCount} comments, ${postData.viewCount} views`);
        
        return postData;
        
    } catch (error) {
        console.log(`Error extracting data from ${contentUrl}:`, error.message);
        return null;
    }
};

// Helper function to extract comments from the specific post
const extractComments = async (page, maxComments) => {
    try {
        const comments = await page.evaluate((maxComments) => {
            const comments = [];
            
            // Enhanced comment selectors for Instagram's current structure
            const commentSelectors = [
                'ul li div span',
                'div[role="button"] span',
                'article ul li span',
                'div[data-testid] span'
            ];
            
            for (const selector of commentSelectors) {
                const elements = document.querySelectorAll(selector);
                
                for (let i = 0; i < Math.min(elements.length, maxComments); i++) {
                    const element = elements[i];
                    const text = element.textContent?.trim();
                    
                    // Better comment validation
                    if (text && 
                        text.length > 5 && 
                        text.length < 500 && 
                        !text.match(/^\d+\s*(like|comment|view|hour|day|week)/i) &&
                        !text.match(/^(like|comment|share|save)$/i) &&
                        text.split(' ').length > 1) {
                        
                        comments.push({
                            text: text,
                            position: comments.length + 1
                        });
                        
                        if (comments.length >= maxComments) break;
                    }
                }
                
                if (comments.length >= maxComments) break;
            }
            
            return comments;
        }, maxComments);
        
        return comments;
    } catch (error) {
        console.log('Error extracting comments:', error.message);
        return [];
    }
};

// Helper function to get posts from profile (enhanced)
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        console.log(`Loading profile: ${profileUrl}`);
        
        // Set mobile-like viewport to potentially bypass some restrictions
        await page.setViewportSize({ width: 414, height: 896 });
        
        await page.goto(profileUrl, { 
            waitUntil: 'networkidle',
            timeout: 30000 
        });
        
        // Wait for content and simulate human behavior
        await humanDelay(3000, 6000);
        
        // Scroll to load more posts
        await page.evaluate(() => {
            window.scrollBy(0, 500);
        });
        
        await humanDelay(2000, 3000);
        
        // Extract post and reel URLs with enhanced selectors
        const contentUrls = await page.evaluate(() => {
            const links = new Set();
            
            // Multiple selectors to catch different Instagram layouts
            const selectors = [
                'a[href*="/p/"]',
                'a[href*="/reel/"]',
                'article a[href*="/p/"]',
                'article a[href*="/reel/"]',
                'div[role="presentation"] a[href*="/p/"]',
                'div[role="presentation"] a[href*="/reel/"]'
            ];
            
            for (const selector of selectors) {
                const anchors = document.querySelectorAll(selector);
                
                for (const anchor of anchors) {
                    const href = anchor.getAttribute('href');
                    if (href && (href.includes('/p/') || href.includes('/reel/'))) {
                        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                        links.add(fullUrl);
                    }
                }
            }
            
            return Array.from(links);
        });
        
        console.log(`Found ${contentUrls.length} content URLs on profile`);
        return contentUrls.slice(0, maxPosts);
        
    } catch (error) {
        console.log(`Error loading profile ${username}:`, error.message);
        return [];
    }
};

// Create proxy configuration
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// Main crawler configuration with enhanced settings
const crawler = new PlaywrightCrawler({
    launchContext: {
        launcher: chromium,
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-dev-shm-usage',
                '--no-zygote',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        }
    },
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    requestHandlerTimeoutSecs,
    maxConcurrency,
    
    // Session management for better success rates
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 5,
            maxErrorScore: 2
        }
    },
    
    // Pre-navigation setup
    preNavigationHooks: [
        async ({ page, request }) => {
            // Set realistic headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Upgrade-Insecure-Requests': '1'
            });
            
            // Set realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }
    ],
    
    async requestHandler({ page, request, log, session }) {
        const url = request.url;
        log.info(`Processing: ${url}`);
        
        try {
            if (url.includes('/p/') || url.includes('/reel/')) {
                // Handle individual post or reel
                const postData = await extractPostData(page, url);
                
                if (postData && (postData.caption || postData.images.length > 0 || postData.videos.length > 0)) {
                    // Apply date filters if specified
                    if (dateFrom || dateTo) {
                        const postDate = new Date(postData.timestamp);
                        if (dateFrom && postDate < new Date(dateFrom)) return;
                        if (dateTo && postDate > new Date(dateTo)) return;
                    }
                    
                    // Extract comments if requested
                    if (includeComments) {
                        postData.comments = await extractComments(page, maxCommentsPerPost);
                    }
                    
                    // Filter data based on user preferences
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
                    log.warning(`❌ No usable data extracted from: ${url}`);
                }
            } else {
                // Handle profile page
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const contentUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${contentUrls.length} content items for ${username}`);
                
                if (contentUrls.length > 0) {
                    // Add content URLs to request queue with delays
                    for (let i = 0; i < contentUrls.length; i++) {
                        await crawler.addRequests([{ url: contentUrls[i] }]);
                        
                        // Add small delay every 10 requests
                        if (i > 0 && i % 10 === 0) {
                            await humanDelay(1000, 2000);
                        }
                    }
                } else {
                    log.warning(`❌ No content found for ${username} - profile may be private or restricted`);
                }
            }
        } catch (error) {
            log.error(`💥 Error processing ${url}:`, error.message);
            
            // If we get blocked, retire the session
            if (error.message.includes('timeout') || error.message.includes('blocked')) {
                session?.retire();
            }
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.error(`💀 Request failed permanently: ${request.url}`);
    }
});

// Add initial requests
const initialRequests = [];

// Add username-based requests (profile pages)
for (const username of usernames) {
    if (username.trim()) {
        const profileUrl = `https://www.instagram.com/${username.trim()}/`;
        initialRequests.push({ url: profileUrl });
    }
}

// Add direct post/reel URLs
for (const contentUrl of postUrls) {
    if (contentUrl.trim() && (contentUrl.includes('/p/') || contentUrl.includes('/reel/'))) {
        initialRequests.push({ url: contentUrl.trim() });
    }
}

if (initialRequests.length === 0) {
    throw new Error('No valid usernames or post URLs provided');
}

console.log(`🚀 Starting Instagram scraper with ${initialRequests.length} initial requests`);
console.log(`⚙️ Config: ${maxConcurrency} concurrency, ${maxRequestRetries} retries, ${requestHandlerTimeoutSecs}s timeout`);

await crawler.addRequests(initialRequests);
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`🎉 Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();