// main.js - Instagram Post Scraper (Enhanced Version)
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

// Helper function to extract comprehensive post/reel data
const extractPostData = async (page, contentUrl) => {
    try {
        console.log(`Starting extraction for: ${contentUrl}`);
        
        // Wait for page to load and check for content
        await page.waitForTimeout(3000);
        
        // Check if we can access the content
        const loginWall = await page.$('input[name="username"], div:has-text("Log in")');
        if (loginWall) {
            console.log('Login wall detected, may affect data quality');
        }
        
        const isReel = contentUrl.includes('/reel/');
        
        // Extract all data in browser context for better performance
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
            
            // Function to extract number from text with K/M/B support
            function parseNumber(text) {
                if (!text) return 0;
                const cleanText = text.replace(/[,\s]/g, '').toLowerCase();
                const match = cleanText.match(/(\d+(?:\.\d+)?)(k|m|b)?/);
                if (!match) return 0;
                
                let num = parseFloat(match[1]);
                const suffix = match[2];
                if (suffix === 'k') num *= 1000;
                else if (suffix === 'm') num *= 1000000;
                else if (suffix === 'b') num *= 1000000000;
                
                return Math.floor(num);
            }
            
            // Extract owner username from URL
            const urlParts = url.split('/').filter(p => p);
            for (let i = 0; i < urlParts.length; i++) {
                if ((urlParts[i] === 'p' || urlParts[i] === 'reel') && i > 0) {
                    post.ownerUsername = urlParts[i - 1];
                    break;
                }
            }
            
            // Get page HTML content for pattern matching
            const pageContent = document.documentElement.innerHTML;
            
            // Extract data from Instagram's JSON (most reliable method)
            const scripts = document.querySelectorAll('script[type="application/json"], script:not([type])');
            let jsonData = null;
            
            for (const script of scripts) {
                const content = script.textContent || script.innerHTML;
                if (content && content.includes('graphql') && content.includes('shortcode_media')) {
                    try {
                        // Try to find and parse Instagram's JSON data
                        const dataMatch = content.match(/{"data":{"shortcode_media":{[^}]+.*?}}}(?=<|\s|$)/);
                        if (dataMatch) {
                            jsonData = JSON.parse(dataMatch[0]);
                            break;
                        }
                    } catch (e) {
                        console.log('JSON parsing failed, continuing...');
                    }
                }
            }
            
            // Extract from JSON data if available
            if (jsonData && jsonData.data && jsonData.data.shortcode_media) {
                const media = jsonData.data.shortcode_media;
                
                // Caption
                if (media.edge_media_to_caption && media.edge_media_to_caption.edges.length > 0) {
                    post.caption = media.edge_media_to_caption.edges[0].node.text || '';
                }
                
                // Engagement metrics
                post.likesCount = media.edge_media_preview_like?.count || 0;
                post.commentsCount = media.edge_media_to_parent_comment?.count || 0;
                if (isReel && media.video_view_count) {
                    post.viewCount = media.video_view_count;
                }
                
                // Timestamp
                if (media.taken_at_timestamp) {
                    post.timestamp = new Date(media.taken_at_timestamp * 1000).toISOString();
                }
                
                // Owner
                if (media.owner && media.owner.username) {
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
                        source: 'json'
                    });
                }
                
                if (media.video_url) {
                    post.videos.push({
                        url: media.video_url,
                        width: media.dimensions?.width || 0,
                        height: media.dimensions?.height || 0,
                        source: 'json'
                    });
                }
                
                // Carousel images
                if (media.edge_sidecar_to_children) {
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
            }
            
            // Fallback: Extract from page content using regex patterns
            if (!post.caption) {
                // Try meta description
                const metaDesc = document.querySelector('meta[property="og:description"]');
                if (metaDesc) {
                    let desc = metaDesc.getAttribute('content') || '';
                    // Clean meta description
                    desc = desc.replace(/^\d+[KMB]?\s*(likes?|followers?|following)[^"]*"/i, '');
                    desc = desc.replace(/^[^"]*"\s*-\s*/, '');
                    desc = desc.replace(/\s*on Instagram.*$/, '');
                    if (desc.length > 10) {
                        post.caption = desc.trim();
                    }
                }
            }
            
            // Extract hashtags and mentions from caption
            if (post.caption) {
                post.hashtags = [...new Set((post.caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
                post.mentions = [...new Set((post.caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
            }
            
            // Fallback media extraction from DOM if JSON failed
            if (post.images.length === 0 && post.videos.length === 0) {
                // Try to find images
                const imageElements = document.querySelectorAll('img');
                for (const img of imageElements) {
                    if (img.src && 
                        (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                        !img.src.includes('profile') &&
                        !img.src.includes('s150x150') &&
                        img.naturalWidth > 400) {
                        post.images.push({
                            url: img.src,
                            width: img.naturalWidth,
                            height: img.naturalHeight,
                            source: 'dom'
                        });
                    }
                }
                
                // Try to find videos
                const videoElements = document.querySelectorAll('video');
                for (const video of videoElements) {
                    if (video.src && !video.src.startsWith('blob:')) {
                        post.videos.push({
                            url: video.src,
                            width: video.videoWidth || 0,
                            height: video.videoHeight || 0,
                            source: 'dom'
                        });
                    }
                }
            }
            
            // Fallback engagement extraction from page text
            if (post.likesCount === 0 || post.commentsCount === 0 || (isReel && post.viewCount === 0)) {
                const pageText = document.body.textContent || '';
                
                // Extract likes
                const likeMatches = pageText.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*likes?/gi);
                if (likeMatches && post.likesCount === 0) {
                    post.likesCount = parseNumber(likeMatches[0]);
                }
                
                // Extract comments
                const commentMatches = pageText.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*comments?/gi);
                if (commentMatches && post.commentsCount === 0) {
                    post.commentsCount = parseNumber(commentMatches[0]);
                }
                
                // Extract views for reels
                if (isReel && post.viewCount === 0) {
                    const viewMatches = pageText.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*views?/gi);
                    if (viewMatches) {
                        post.viewCount = parseNumber(viewMatches[0]);
                    }
                }
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
        
        // Log extraction results
        console.log(`Extraction complete for ${contentUrl}:`);
        console.log(`- Caption: ${postData.caption ? 'Found' : 'Missing'}`);
        console.log(`- Images: ${postData.images.length}`);
        console.log(`- Videos: ${postData.videos.length}`);
        console.log(`- Likes: ${postData.likesCount}, Comments: ${postData.commentsCount}, Views: ${postData.viewCount}`);
        
        return postData;
        
    } catch (error) {
        console.log(`Error extracting data from ${contentUrl}:`, error.message);
        return null;
    }
};

// Helper function to extract comments
const extractComments = async (page, maxComments) => {
    try {
        const comments = await page.evaluate((maxComments) => {
            const commentElements = document.querySelectorAll('article ul li, [role="button"] span');
            const comments = [];
            
            for (let i = 0; i < Math.min(commentElements.length, maxComments); i++) {
                const element = commentElements[i];
                const text = element.textContent?.trim();
                if (text && text.length > 5 && !text.includes('like') && !text.includes('reply')) {
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

// Helper function to get posts AND reels from profile
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        console.log(`Loading profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for page to load
        await page.waitForTimeout(5000);
        
        // Check what's actually on the page
        const pageContent = await page.content();
        console.log('Page loaded. Checking for content...');
        
        // Check for login wall
        const loginWall = await page.$('input[name="username"], [role="button"]:has-text("Log in"), div:has-text("Log in")');
        if (loginWall) {
            console.log('Login wall detected. Attempting to continue...');
        }
        
        // Check for profile content indicators
        const hasProfile = await page.$('main, article, [role="main"]');
        if (!hasProfile) {
            console.log('No main content found. Page might be blocked.');
            // Try to take a screenshot for debugging
            try {
                await page.screenshot({ path: 'debug-page.png', fullPage: false });
                console.log('Debug screenshot saved');
            } catch (e) {
                console.log('Could not save screenshot');
            }
        }
        
        // Try multiple approaches to find content
        console.log('Searching for post/reel links...');
        
        // Method 1: Look for post/reel links in href attributes
        let contentUrls = await page.evaluate(() => {
            const links = [];
            
            // Try various selectors for post links
            const selectors = [
                'a[href*="/p/"]',
                'a[href*="/reel/"]',
                '[href*="/p/"]',
                '[href*="/reel/"]'
            ];
            
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                console.log(`Found ${elements.length} elements with selector: ${selector}`);
                
                for (const element of elements) {
                    const href = element.getAttribute('href');
                    if (href) {
                        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                        links.push(fullUrl);
                        console.log(`Found link: ${fullUrl}`);
                    }
                }
            }
            
            return [...new Set(links)];
        });
        
        console.log(`Method 1 found ${contentUrls.length} URLs`);
        
        // Method 2: If no links found, try scrolling and searching again
        if (contentUrls.length === 0) {
            console.log('No links found initially. Trying scroll and search...');
            
            // Scroll down to load more content
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(2000);
            }
            
            contentUrls = await page.evaluate(() => {
                const links = [];
                const allLinks = document.querySelectorAll('a');
                
                for (const link of allLinks) {
                    const href = link.getAttribute('href');
                    if (href && (href.includes('/p/') || href.includes('/reel/'))) {
                        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                        links.push(fullUrl);
                    }
                }
                
                return [...new Set(links)];
            });
            
            console.log(`Method 2 found ${contentUrls.length} URLs after scrolling`);
        }
        
        // Method 3: Extract from page source if still no links
        if (contentUrls.length === 0) {
            console.log('Still no links. Searching page source...');
            
            const pageSource = await page.content();
            const postMatches = pageSource.match(/\/(?:p|reel)\/[A-Za-z0-9_-]+/g);
            
            if (postMatches) {
                contentUrls = [...new Set(postMatches.map(match => `https://www.instagram.com${match}/`))];
                console.log(`Method 3 found ${contentUrls.length} URLs from page source`);
            }
        }
        
        // Debug: Log page info if still no content
        if (contentUrls.length === 0) {
            console.log('DEBUG: No content found. Page analysis:');
            
            const pageInfo = await page.evaluate(() => {
                return {
                    title: document.title,
                    hasMain: !!document.querySelector('main'),
                    hasArticle: !!document.querySelector('article'),
                    linkCount: document.querySelectorAll('a').length,
                    imageCount: document.querySelectorAll('img').length,
                    bodyText: document.body.textContent.substring(0, 500)
                };
            });
            
            console.log('Page info:', pageInfo);
        }
        
        console.log(`Final result: Found ${contentUrls.length} content URLs on profile`);
        return contentUrls.slice(0, maxPosts);
        
    } catch (error) {
        console.log(`Error loading profile ${username}:`, error.message);
        
        // Try to get some debug info even on error
        try {
            const currentUrl = await page.url();
            console.log(`Current URL: ${currentUrl}`);
            
            const pageTitle = await page.title();
            console.log(`Page title: ${pageTitle}`);
        } catch (e) {
            console.log('Could not get debug info');
        }
        
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