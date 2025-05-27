// main.js - Instagram Post Scraper (Direct API Approach)
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

// Helper function to intercept Instagram's API responses
const extractPostData = async (page, contentUrl) => {
    try {
        console.log(`Extracting data for: ${contentUrl}`);
        
        const isReel = contentUrl.includes('/reel/');
        const shortcode = isReel ? contentUrl.split('/reel/')[1]?.split('/')[0] : contentUrl.split('/p/')[1]?.split('/')[0];
        
        // Set up response interception to catch Instagram's API calls
        const apiData = { media: null, comments: [] };
        
        page.on('response', async (response) => {
            const url = response.url();
            
            // Intercept GraphQL API calls
            if (url.includes('graphql') && response.status() === 200) {
                try {
                    const data = await response.json();
                    
                    // Check if this response contains our post data
                    if (data.data && data.data.shortcode_media) {
                        console.log('Intercepted Instagram API response');
                        apiData.media = data.data.shortcode_media;
                    }
                    
                    // Check for comments data
                    if (data.data && data.data.shortcode_media && data.data.shortcode_media.edge_media_to_parent_comment) {
                        apiData.comments = data.data.shortcode_media.edge_media_to_parent_comment.edges || [];
                    }
                } catch (e) {
                    // Not JSON or different format
                }
            }
        });
        
        // Navigate to the post
        await page.goto(contentUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        
        // If we didn't intercept API data, try to trigger it by scrolling/interacting
        if (!apiData.media) {
            console.log('No API data intercepted, trying to trigger API calls...');
            
            // Try scrolling to trigger more API calls
            await page.evaluate(() => {
                window.scrollBy(0, 500);
            });
            await page.waitForTimeout(2000);
            
            // Try clicking on elements to trigger API calls
            try {
                const likeButton = await page.$('button[aria-label*="like"], svg[aria-label*="like"]');
                if (likeButton) {
                    await likeButton.hover();
                    await page.waitForTimeout(1000);
                }
            } catch (e) {
                // Continue without interaction
            }
        }
        
        // Process the intercepted data or fallback to page parsing
        const postData = await page.evaluate(async ({ url, isReel, shortcode, apiData }) => {
            const post = {
                url,
                isReel,
                shortcode,
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
            
            // Extract owner username from URL
            const urlParts = url.split('/').filter(p => p);
            for (let i = 0; i < urlParts.length; i++) {
                if ((urlParts[i] === 'p' || urlParts[i] === 'reel') && i > 0) {
                    post.ownerUsername = urlParts[i - 1];
                    break;
                }
            }
            
            // Use intercepted API data if available
            if (apiData.media) {
                console.log('Using intercepted API data');
                const media = apiData.media;
                
                // Clean caption extraction
                if (media.edge_media_to_caption?.edges?.[0]?.node?.text) {
                    post.caption = media.edge_media_to_caption.edges[0].node.text;
                }
                
                // Engagement metrics
                post.likesCount = media.edge_media_preview_like?.count || 0;
                post.commentsCount = media.edge_media_to_parent_comment?.count || 0;
                post.viewCount = media.video_view_count || 0;
                
                // Timestamp
                if (media.taken_at_timestamp) {
                    post.timestamp = new Date(media.taken_at_timestamp * 1000).toISOString();
                }
                
                // Owner
                if (media.owner?.username) {
                    post.ownerUsername = media.owner.username;
                }
                
                // Location
                if (media.location) {
                    post.locationName = media.location.name || '';
                    post.locationId = media.location.id || '';
                }
                
                // Media URLs
                if (media.display_url) {
                    post.images.push({
                        url: media.display_url,
                        width: media.dimensions?.width || 0,
                        height: media.dimensions?.height || 0,
                        source: 'api'
                    });
                }
                
                if (media.video_url) {
                    post.videos.push({
                        url: media.video_url,
                        width: media.dimensions?.width || 0,
                        height: media.dimensions?.height || 0,
                        source: 'api'
                    });
                }
                
                // Carousel content
                if (media.edge_sidecar_to_children?.edges) {
                    for (const edge of media.edge_sidecar_to_children.edges) {
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
            } else {
                // Fallback: Parse from page scripts
                console.log('Falling back to script parsing');
                
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const content = script.textContent || '';
                    
                    if (content.includes(shortcode) && content.includes('display_url')) {
                        try {
                            // Try to extract post data from script content
                            const regex = new RegExp(`"shortcode":"${shortcode}"[^}]*"display_url":"([^"]+)"`, 'i');
                            const match = content.match(regex);
                            
                            if (match && match[1]) {
                                post.images.push({
                                    url: match[1].replace(/\\u0026/g, '&'),
                                    source: 'script'
                                });
                            }
                            
                            // Try to extract video URL
                            const videoRegex = new RegExp(`"shortcode":"${shortcode}"[^}]*"video_url":"([^"]+)"`, 'i');
                            const videoMatch = content.match(videoRegex);
                            
                            if (videoMatch && videoMatch[1]) {
                                post.videos.push({
                                    url: videoMatch[1].replace(/\\u0026/g, '&'),
                                    source: 'script'
                                });
                            }
                            
                            // Try to extract caption
                            const captionRegex = new RegExp(`"shortcode":"${shortcode}"[^}]*"text":"([^"]+)"`, 'i');
                            const captionMatch = content.match(captionRegex);
                            
                            if (captionMatch && captionMatch[1]) {
                                post.caption = captionMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            }
                            
                            // Try to extract engagement
                            const likeRegex = new RegExp(`"shortcode":"${shortcode}"[^}]*"edge_media_preview_like":\\{"count":(\\d+)`, 'i');
                            const likeMatch = content.match(likeRegex);
                            if (likeMatch) {
                                post.likesCount = parseInt(likeMatch[1]);
                            }
                            
                            const commentRegex = new RegExp(`"shortcode":"${shortcode}"[^}]*"edge_media_to_parent_comment":\\{"count":(\\d+)`, 'i');
                            const commentMatch = content.match(commentRegex);
                            if (commentMatch) {
                                post.commentsCount = parseInt(commentMatch[1]);
                            }
                            
                            const viewRegex = new RegExp(`"shortcode":"${shortcode}"[^}]*"video_view_count":(\\d+)`, 'i');
                            const viewMatch = content.match(viewRegex);
                            if (viewMatch) {
                                post.viewCount = parseInt(viewMatch[1]);
                            }
                            
                            break;
                        } catch (e) {
                            console.log('Error parsing script content:', e.message);
                        }
                    }
                }
                
                // Last resort: clean meta description for caption
                if (!post.caption) {
                    const metaDesc = document.querySelector('meta[property="og:description"]');
                    if (metaDesc?.content) {
                        let desc = metaDesc.content;
                        // Remove engagement metrics and metadata
                        desc = desc.replace(/^\d+[KMB]?\s*(likes?|comments?)[^"]*-\s*[^"]*\s*on\s*[^:]*:\s*"?/, '');
                        desc = desc.replace(/".+$/, ''); // Remove trailing quotes and text
                        if (desc.length > 20) {
                            post.caption = desc.trim();
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
        }, { url: contentUrl, isReel, shortcode, apiData });
        
        console.log(`Extraction complete for ${contentUrl}:`);
        console.log(`- Caption: ${postData.caption ? 'Found (' + postData.caption.length + ' chars)' : 'Not found'}`);
        console.log(`- Media: ${postData.images.length} images, ${postData.videos.length} videos`);
        console.log(`- Engagement: ${postData.likesCount} likes, ${postData.commentsCount} comments, ${postData.viewCount} views`);
        
        return postData;
        
    } catch (error) {
        console.log(`Error extracting data from ${contentUrl}:`, error.message);
        return null;
    }
};

// Helper function to extract comments
const extractComments = async (page, maxComments) => {
    try {
        // Look for comment data in intercepted API responses or DOM
        const comments = await page.evaluate((maxComments) => {
            const comments = [];
            
            // Try to find comments in the page
            const commentElements = document.querySelectorAll('article ul li, [role="article"] div');
            
            for (let i = 0; i < Math.min(commentElements.length, maxComments); i++) {
                const element = commentElements[i];
                const text = element.textContent?.trim();
                
                if (text && text.length > 15 && text.length < 300 && 
                    !text.includes('like') && !text.includes('reply') && 
                    !text.match(/^\d+/)) {
                    comments.push({
                        text: text,
                        position: i + 1
                    });
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

// Helper function to get posts from profile
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        console.log(`Loading profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
        
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
                const postData = await extractPostData(page, url);
                
                if (postData) {
                    if (dateFrom || dateTo) {
                        const postDate = new Date(postData.timestamp);
                        if (dateFrom && postDate < new Date(dateFrom)) return;
                        if (dateTo && postDate > new Date(dateTo)) return;
                    }
                    
                    if (includeComments) {
                        postData.comments = await extractComments(page, maxCommentsPerPost);
                    }
                    
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
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const contentUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${contentUrls.length} content items for ${username}`);
                
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

for (const username of usernames) {
    if (username.trim()) {
        const profileUrl = `https://www.instagram.com/${username.trim()}/`;
        initialRequests.push({ url: profileUrl });
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

console.log(`Starting scraper with ${initialRequests.length} initial requests`);

await crawler.addRequests(initialRequests);
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();