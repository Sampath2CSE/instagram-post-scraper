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
            
            // Extract from JSON data if available (most reliable)
            if (jsonData && jsonData.data && jsonData.data.shortcode_media) {
                const media = jsonData.data.shortcode_media;
                console.log('Found Instagram JSON data, extracting...');
                
                // Caption
                if (media.edge_media_to_caption && media.edge_media_to_caption.edges.length > 0) {
                    post.caption = media.edge_media_to_caption.edges[0].node.text || '';
                }
                
                // Engagement metrics
                post.likesCount = media.edge_media_preview_like?.count || 0;
                post.commentsCount = media.edge_media_to_parent_comment?.count || 0;
                
                // Views for reels/videos
                if (media.video_view_count) {
                    post.viewCount = media.video_view_count;
                } else if (media.video_play_count) {
                    post.viewCount = media.video_play_count;
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
                
                // Media URLs - Single post/reel
                if (media.display_url) {
                    console.log('Found display_url in JSON');
                    post.images.push({
                        url: media.display_url,
                        width: media.dimensions?.width || 0,
                        height: media.dimensions?.height || 0,
                        source: 'json'
                    });
                }
                
                if (media.video_url) {
                    console.log('Found video_url in JSON');
                    post.videos.push({
                        url: media.video_url,
                        width: media.dimensions?.width || 0,
                        height: media.dimensions?.height || 0,
                        source: 'json'
                    });
                }
                
                // Carousel images/videos
                if (media.edge_sidecar_to_children && media.edge_sidecar_to_children.edges) {
                    console.log(`Found carousel with ${media.edge_sidecar_to_children.edges.length} items`);
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
                
                console.log(`JSON extraction complete. Images: ${post.images.length}, Videos: ${post.videos.length}`);
            } else {
                console.log('No Instagram JSON data found, trying alternative methods...');
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
            
            // Enhanced fallback media extraction with more aggressive searching
            if (post.images.length === 0 && post.videos.length === 0) {
                console.log('JSON method failed, trying DOM extraction...');
                
                // Method 1: Search for images with better patterns
                const imageElements = document.querySelectorAll('img[src], img[data-src], [style*="background-image"]');
                console.log(`Found ${imageElements.length} potential image elements`);
                
                for (const img of imageElements) {
                    let imgUrl = img.src || img.getAttribute('data-src');
                    
                    // Also check background images
                    if (!imgUrl && img.style.backgroundImage) {
                        const bgMatch = img.style.backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
                        if (bgMatch) imgUrl = bgMatch[1];
                    }
                    
                    if (imgUrl && 
                        (imgUrl.includes('scontent') || imgUrl.includes('cdninstagram')) &&
                        !imgUrl.includes('profile') &&
                        !imgUrl.includes('s150x150') &&
                        !imgUrl.includes('44x44') &&
                        (img.naturalWidth > 400 || imgUrl.includes('1080') || imgUrl.includes('640'))) {
                        
                        post.images.push({
                            url: imgUrl,
                            width: img.naturalWidth || 0,
                            height: img.naturalHeight || 0,
                            source: 'dom'
                        });
                    }
                }
                
                // Method 2: Search for videos
                const videoElements = document.querySelectorAll('video[src], video source, [data-video-url]');
                console.log(`Found ${videoElements.length} potential video elements`);
                
                for (const video of videoElements) {
                    let videoUrl = video.src || video.getAttribute('data-video-url');
                    
                    if (!videoUrl && video.tagName === 'SOURCE') {
                        videoUrl = video.src;
                    }
                    
                    if (videoUrl && 
                        !videoUrl.startsWith('blob:') && 
                        !videoUrl.startsWith('data:') &&
                        (videoUrl.includes('scontent') || videoUrl.includes('cdninstagram') || videoUrl.includes('instagram'))) {
                        
                        post.videos.push({
                            url: videoUrl,
                            width: video.videoWidth || 0,
                            height: video.videoHeight || 0,
                            source: 'dom'
                        });
                    }
                }
                
                // Method 3: Search in page HTML for media URLs
                if (post.images.length === 0 && post.videos.length === 0) {
                    console.log('DOM method also failed, searching page HTML...');
                    
                    const htmlContent = document.documentElement.innerHTML;
                    
                    // Look for image URLs in the HTML
                    const imageMatches = htmlContent.match(/https:\/\/[^"'\s]*(?:scontent|cdninstagram)[^"'\s]*\.(?:jpg|jpeg|png|webp)/gi);
                    if (imageMatches) {
                        console.log(`Found ${imageMatches.length} image URLs in HTML`);
                        for (const match of imageMatches.slice(0, 10)) {
                            if (!match.includes('s150x150') && !match.includes('profile')) {
                                post.images.push({
                                    url: match,
                                    source: 'html'
                                });
                            }
                        }
                    }
                    
                    // Look for video URLs in the HTML
                    const videoMatches = htmlContent.match(/https:\/\/[^"'\s]*(?:scontent|cdninstagram)[^"'\s]*\.(?:mp4|mov|webm)/gi);
                    if (videoMatches) {
                        console.log(`Found ${videoMatches.length} video URLs in HTML`);
                        for (const match of videoMatches.slice(0, 5)) {
                            post.videos.push({
                                url: match,
                                source: 'html'
                            });
                        }
                    }
                }
                
                console.log(`DOM/HTML extraction complete. Images: ${post.images.length}, Videos: ${post.videos.length}`);
            }
            
            // Enhanced fallback engagement extraction with better view count detection
            if (post.likesCount === 0 || post.commentsCount === 0 || (isReel && post.viewCount === 0)) {
                console.log('Extracting engagement from page text...');
                
                const pageText = document.body.textContent || '';
                
                // Extract likes with more patterns
                if (post.likesCount === 0) {
                    const likePatterns = [
                        /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*likes?/gi,
                        /(\d+(?:,\d+)*)\s*likes?/gi
                    ];
                    
                    for (const pattern of likePatterns) {
                        const matches = pageText.match(pattern);
                        if (matches && matches.length > 0) {
                            post.likesCount = parseNumber(matches[0]);
                            if (post.likesCount > 0) break;
                        }
                    }
                }
                
                // Extract comments with more patterns
                if (post.commentsCount === 0) {
                    const commentPatterns = [
                        /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*comments?/gi,
                        /(\d+(?:,\d+)*)\s*comments?/gi
                    ];
                    
                    for (const pattern of commentPatterns) {
                        const matches = pageText.match(pattern);
                        if (matches && matches.length > 0) {
                            post.commentsCount = parseNumber(matches[0]);
                            if (post.commentsCount > 0) break;
                        }
                    }
                }
                
                // Enhanced view count extraction for reels
                if (isReel && post.viewCount === 0) {
                    console.log('Searching for view count in reel...');
                    
                    // Try multiple view count patterns
                    const viewPatterns = [
                        /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*views?/gi,
                        /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*plays?/gi,
                        /(\d+[KMB]?)\s*views?/gi,
                        /views?\s*(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/gi
                    ];
                    
                    for (const pattern of viewPatterns) {
                        const matches = pageText.match(pattern);
                        if (matches && matches.length > 0) {
                            console.log(`Found view matches: ${matches.slice(0, 3)}`);
                            
                            // Try each match until we find a reasonable number
                            for (const match of matches) {
                                const parsed = parseNumber(match);
                                if (parsed > 100) { // Only accept view counts > 100 to avoid false positives
                                    post.viewCount = parsed;
                                    console.log(`Set view count to: ${post.viewCount}`);
                                    break;
                                }
                            }
                            if (post.viewCount > 0) break;
                        }
                    }
                    
                    // Alternative: Look in specific DOM elements for reels
                    if (post.viewCount === 0) {
                        const viewElements = document.querySelectorAll('[aria-label*="view"], [title*="view"], span, div');
                        for (const element of viewElements) {
                            const text = element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '';
                            if (text.toLowerCase().includes('view')) {
                                const viewMatch = text.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/);
                                if (viewMatch) {
                                    const parsed = parseNumber(viewMatch[0]);
                                    if (parsed > 100) {
                                        post.viewCount = parsed;
                                        console.log(`Found view count in element: ${post.viewCount}`);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                
                console.log(`Engagement extraction complete. Likes: ${post.likesCount}, Comments: ${post.commentsCount}, Views: ${post.viewCount}`);
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