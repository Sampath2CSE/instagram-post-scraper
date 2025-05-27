// main.js - Instagram Post Scraper (Reliable Version)
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
    maxRequestRetries = 3,
    requestHandlerTimeoutSecs = 60,
    maxConcurrency = 5,
    dateFrom,
    dateTo
} = input;

// Initialize dataset for storing results
const dataset = await Dataset.open();

// Helper function to extract data using Instagram's internal API data
const extractPostData = async (page, contentUrl) => {
    try {
        console.log(`Extracting data for: ${contentUrl}`);
        
        // Wait for page to load
        await page.waitForTimeout(5000);
        
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
            
            // Method 1: Try to find Instagram's GraphQL data (most reliable)
            let foundData = false;
            const scripts = document.querySelectorAll('script');
            
            for (const script of scripts) {
                const content = script.textContent || '';
                
                // Look for the specific post data in Instagram's JSON
                if (content.includes('{"data":{"shortcode_media":') || content.includes('"shortcode_media"')) {
                    try {
                        // Try to extract the GraphQL response
                        let jsonMatch = content.match(/"shortcode_media":\s*({[^}]+(?:{[^}]*}[^}]*)*})/);
                        if (!jsonMatch) {
                            // Alternative pattern
                            jsonMatch = content.match(/{"data":{"shortcode_media":({[^}]+(?:{[^}]*}[^}]*)*})}/);
                        }
                        
                        if (jsonMatch) {
                            const mediaData = JSON.parse(jsonMatch[1]);
                            console.log('Found Instagram media data');
                            
                            // Extract caption
                            if (mediaData.edge_media_to_caption?.edges?.[0]?.node?.text) {
                                post.caption = mediaData.edge_media_to_caption.edges[0].node.text;
                            }
                            
                            // Extract engagement
                            if (mediaData.edge_media_preview_like?.count) {
                                post.likesCount = mediaData.edge_media_preview_like.count;
                            }
                            if (mediaData.edge_media_to_parent_comment?.count) {
                                post.commentsCount = mediaData.edge_media_to_parent_comment.count;
                            }
                            if (mediaData.video_view_count) {
                                post.viewCount = mediaData.video_view_count;
                            }
                            
                            // Extract timestamp
                            if (mediaData.taken_at_timestamp) {
                                post.timestamp = new Date(mediaData.taken_at_timestamp * 1000).toISOString();
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
                            break;
                        }
                    } catch (e) {
                        console.log('Error parsing Instagram data:', e.message);
                    }
                }
            }
            
            // Method 2: Fallback to meta tags if GraphQL data not found
            if (!foundData || !post.caption) {
                const metaDesc = document.querySelector('meta[property="og:description"]');
                if (metaDesc && metaDesc.content) {
                    let content = metaDesc.content;
                    
                    // Clean the meta description to get just the caption
                    // Remove engagement metrics from start
                    content = content.replace(/^\d+[KMB]?\s*(likes?|followers?|following)[^"]*"\s*-\s*/, '');
                    content = content.replace(/^[^"]*"\s*-\s*/, ''); // Remove quoted usernames
                    content = content.replace(/\s*on Instagram.*$/, ''); // Remove Instagram suffix
                    
                    if (content.length > 10 && !post.caption) {
                        post.caption = content.trim();
                    }
                }
            }
            
            // Method 3: Extract engagement from aria-labels and visible text (only if not found in JSON)
            if (!foundData && (post.likesCount === 0 || post.commentsCount === 0 || (isReel && post.viewCount === 0))) {
                // Look for engagement metrics in specific elements
                const buttons = document.querySelectorAll('button[aria-label], span[aria-label], section span');
                
                for (const button of buttons) {
                    const ariaLabel = button.getAttribute('aria-label') || '';
                    const text = button.textContent || '';
                    const fullText = (ariaLabel + ' ' + text).toLowerCase();
                    
                    // Extract likes
                    if (post.likesCount === 0 && fullText.includes('like') && !fullText.includes('unlike')) {
                        const likeMatch = fullText.match(/(\d+(?:,\d+)*)\s*like/);
                        if (likeMatch) {
                            post.likesCount = parseInt(likeMatch[1].replace(/,/g, ''));
                        }
                    }
                    
                    // Extract comments
                    if (post.commentsCount === 0 && fullText.includes('comment')) {
                        const commentMatch = fullText.match(/(\d+(?:,\d+)*)\s*comment/);
                        if (commentMatch) {
                            post.commentsCount = parseInt(commentMatch[1].replace(/,/g, ''));
                        }
                    }
                    
                    // Extract views for reels
                    if (isReel && post.viewCount === 0 && (fullText.includes('view') || fullText.includes('play'))) {
                        const viewMatch = fullText.match(/(\d+(?:,\d+)*)\s*(?:view|play)/);
                        if (viewMatch) {
                            const views = parseInt(viewMatch[1].replace(/,/g, ''));
                            if (views > 100) { // Only accept reasonable view counts
                                post.viewCount = views;
                            }
                        }
                    }
                }
            }
            
            // Method 4: Fallback media extraction (only if not found in JSON)
            if (post.images.length === 0 && post.videos.length === 0) {
                // Only look for media within the main article/content area
                const mainContent = document.querySelector('main article, main, article');
                if (mainContent) {
                    // Look for images within the main content
                    const images = mainContent.querySelectorAll('img[src]');
                    for (const img of images) {
                        if (img.src && 
                            (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                            !img.src.includes('profile') &&
                            !img.src.includes('s150x150') &&
                            img.naturalWidth > 300) {
                            
                            post.images.push({
                                url: img.src,
                                width: img.naturalWidth,
                                height: img.naturalHeight,
                                source: 'fallback'
                            });
                        }
                    }
                    
                    // Look for videos within the main content
                    const videos = mainContent.querySelectorAll('video[src], video source');
                    for (const video of videos) {
                        const videoUrl = video.src || video.querySelector('source')?.src;
                        if (videoUrl && !videoUrl.startsWith('blob:')) {
                            post.videos.push({
                                url: videoUrl,
                                width: video.videoWidth || 0,
                                height: video.videoHeight || 0,
                                source: 'fallback'
                            });
                        }
                    }
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
        }, { url: contentUrl, isReel });
        
        console.log(`Extraction result for ${contentUrl}:`);
        console.log(`- Caption found: ${postData.caption ? 'Yes' : 'No'}`);
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
            
            // Look for comments specifically within the main article
            const mainContent = document.querySelector('main article, article');
            if (mainContent) {
                const commentElements = mainContent.querySelectorAll('ul li, div[role="button"]');
                
                for (let i = 0; i < Math.min(commentElements.length, maxComments); i++) {
                    const element = commentElements[i];
                    const text = element.textContent?.trim();
                    
                    // Only include if it looks like a comment (has reasonable length, not just numbers)
                    if (text && text.length > 10 && text.length < 500 && !text.match(/^\d+\s*(like|comment|view)/)) {
                        comments.push({
                            text: text,
                            position: i + 1
                        });
                    }
                }
            }
            
            return comments;
        }, maxComments);
        
        return comments;
    } catch (error) {
        console.log('Error extracting comments:', error.message);
        return [];
    }
};

// Helper function to get posts from profile (simplified)
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        console.log(`Loading profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
        
        // Extract post and reel URLs
        const contentUrls = await page.evaluate(() => {
            const links = [];
            const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
            
            for (const anchor of anchors) {
                const href = anchor.getAttribute('href');
                if (href && (href.includes('/p/') || href.includes('/reel/'))) {
                    const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                    links.push(fullUrl);
                }
            }
            
            return [...new Set(links)];
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

// Main crawler configuration
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
                '--disable-features=VizDisplayCompositor'
            ]
        }
    },
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    requestHandlerTimeoutSecs,
    maxConcurrency,
    
    async requestHandler({ page, request, log }) {
        const url = request.url;
        log.info(`Processing: ${url}`);
        
        try {
            if (url.includes('/p/') || url.includes('/reel/')) {
                // Handle individual post or reel
                const postData = await extractPostData(page, url);
                
                if (postData) {
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
                    log.info(`Successfully scraped ${postData.isReel ? 'reel' : 'post'}: ${url}`);
                }
            } else {
                // Handle profile page
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const contentUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${contentUrls.length} content items for ${username}`);
                
                // Add content URLs to request queue
                for (const contentUrl of contentUrls) {
                    await crawler.addRequests([{ url: contentUrl }]);
                }
            }
        } catch (error) {
            log.error(`Error processing ${url}:`, error);
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.error(`Request ${request.url} failed multiple times`);
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

console.log(`Starting scraper with ${initialRequests.length} initial requests`);

await crawler.addRequests(initialRequests);
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();