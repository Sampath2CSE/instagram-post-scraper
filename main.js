// main.js - Instagram Post Scraper
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

// Helper function to extract post data
const extractPostData = async (page, postUrl) => {
    try {
        // Wait for content to load
        await page.waitForSelector('article', { timeout: 30000 });
        
        const postData = await page.evaluate((url) => {
            const post = {};
            
            // Basic post information
            post.url = url;
            post.shortcode = url.split('/p/')[1]?.split('/')[0] || '';
            
            // Try to find post content using various selectors
            const captionSelectors = [
                'article h1',
                'article div[data-testid="post-text"]',
                'article span[dir="auto"]',
                'meta[property="og:description"]'
            ];
            
            let caption = '';
            for (const selector of captionSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    caption = selector === 'meta[property="og:description"]' 
                        ? element.getAttribute('content') 
                        : element.textContent;
                    if (caption) break;
                }
            }
            post.caption = caption?.trim() || '';
            
            // Extract hashtags and mentions from caption
            if (caption) {
                post.hashtags = [...new Set((caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
                post.mentions = [...new Set((caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
            } else {
                post.hashtags = [];
                post.mentions = [];
            }
            
            // Get post owner information
            const ownerLink = document.querySelector('article a[role="link"]');
            if (ownerLink) {
                const href = ownerLink.getAttribute('href');
                post.ownerUsername = href?.replace('/', '') || '';
            }
            
            // Try to extract engagement metrics
            const likeButtons = document.querySelectorAll('button[aria-label*="like"], span[aria-label*="like"]');
            const commentButtons = document.querySelectorAll('button[aria-label*="comment"], span[aria-label*="comment"]');
            
            // Extract like count
            let likeCount = 0;
            for (const btn of likeButtons) {
                const ariaLabel = btn.getAttribute('aria-label');
                const match = ariaLabel?.match(/(\d+(?:,\d+)*)\s*like/i);
                if (match) {
                    likeCount = parseInt(match[1].replace(/,/g, ''));
                    break;
                }
            }
            post.likesCount = likeCount;
            
            // Extract comment count
            let commentCount = 0;
            for (const btn of commentButtons) {
                const ariaLabel = btn.getAttribute('aria-label');
                const match = ariaLabel?.match(/(\d+(?:,\d+)*)\s*comment/i);
                if (match) {
                    commentCount = parseInt(match[1].replace(/,/g, ''));
                    break;
                }
            }
            post.commentsCount = commentCount;
            
            // Extract media information
            const images = Array.from(document.querySelectorAll('article img[src*="instagram.com"]'))
                .map(img => ({
                    url: img.src,
                    alt: img.alt || ''
                }));
            
            const videos = Array.from(document.querySelectorAll('article video'))
                .map(video => ({
                    url: video.src || video.querySelector('source')?.src,
                    poster: video.poster
                }));
            
            post.images = images;
            post.videos = videos;
            
            // Determine post type
            if (videos.length > 0) {
                post.type = videos.length === 1 ? 'video' : 'carousel_video';
            } else if (images.length > 1) {
                post.type = 'carousel_album';
            } else {
                post.type = 'image';
            }
            
            // Try to extract timestamp
            const timeElement = document.querySelector('time[datetime]');
            if (timeElement) {
                post.timestamp = timeElement.getAttribute('datetime');
            }
            
            // Extract location if available
            const locationElement = document.querySelector('a[href*="/explore/locations/"]');
            if (locationElement) {
                post.locationName = locationElement.textContent?.trim();
                const href = locationElement.getAttribute('href');
                const locationId = href?.match(/\/explore\/locations\/(\d+)/)?.[1];
                if (locationId) {
                    post.locationId = locationId;
                }
            }
            
            return post;
        }, postUrl);
        
        return postData;
    } catch (error) {
        console.log(`Error extracting post data from ${postUrl}:`, error.message);
        return null;
    }
};

// Helper function to extract comments
const extractComments = async (page, maxComments) => {
    const comments = [];
    
    try {
        // Look for comment sections
        const commentSelectors = [
            'article ul li div[data-testid="comment"]',
            'article div[role="button"] span[dir="auto"]',
            'article ul li span'
        ];
        
        let commentElements = [];
        for (const selector of commentSelectors) {
            commentElements = await page.$$(selector);
            if (commentElements.length > 0) break;
        }
        
        for (let i = 0; i < Math.min(commentElements.length, maxComments); i++) {
            const element = commentElements[i];
            const commentText = await element.textContent();
            const usernameElement = await element.$('a');
            const username = usernameElement ? await usernameElement.textContent() : '';
            
            if (commentText && commentText.trim()) {
                comments.push({
                    text: commentText.trim(),
                    username: username.trim(),
                    position: i + 1
                });
            }
        }
    } catch (error) {
        console.log('Error extracting comments:', error.message);
    }
    
    return comments;
};

// Helper function to get posts from profile
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle' });
        await page.waitForSelector('main', { timeout: 30000 });
        
        // Scroll to load more posts
        let postLinks = [];
        let scrollAttempts = 0;
        const maxScrollAttempts = 10;
        
        while (postLinks.length < maxPosts && scrollAttempts < maxScrollAttempts) {
            // Get current post links
            const currentLinks = await page.$$eval(
                'a[href*="/p/"]',
                links => links.map(link => link.href).slice(0, Math.min(links.length, 50))
            );
            
            postLinks = [...new Set([...postLinks, ...currentLinks])];
            
            if (postLinks.length >= maxPosts) break;
            
            // Scroll down to load more
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2000);
            scrollAttempts++;
        }
        
        return postLinks.slice(0, maxPosts);
    } catch (error) {
        console.log(`Error getting posts from profile ${username}:`, error.message);
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
            if (url.includes('/p/')) {
                // Handle individual post
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
                    }
                    
                    postData.scrapedAt = new Date().toISOString();
                    
                    await dataset.pushData(postData);
                    log.info(`Successfully scraped post: ${url}`);
                }
            } else {
                // Handle profile page - get post URLs
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const postUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${postUrls.length} posts for ${username}`);
                
                // Add post URLs to request queue
                for (const postUrl of postUrls) {
                    await crawler.addRequests([{ url: postUrl }]);
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

// Add direct post URLs
for (const postUrl of postUrls) {
    if (postUrl.trim() && postUrl.includes('/p/')) {
        initialRequests.push({ url: postUrl.trim() });
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