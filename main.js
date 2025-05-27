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
        // Wait for content to load with longer timeout
        await page.waitForTimeout(5000);
        
        const postData = await page.evaluate((url) => {
            const post = {};
            
            // Basic post information
            post.url = url;
            post.shortcode = url.split('/p/')[1]?.split('/')[0] || '';
            
            // Try multiple approaches to get caption
            let caption = '';
            
            // Method 1: Try meta description
            const metaDesc = document.querySelector('meta[property="og:description"]');
            if (metaDesc) {
                caption = metaDesc.getAttribute('content') || '';
            }
            
            // Method 2: Try various caption selectors
            if (!caption) {
                const captionSelectors = [
                    'article div[data-testid="post-text"]',
                    'article h1',
                    'article span[dir="auto"]',
                    'div[role="button"] span',
                    'article div span',
                    'main article span'
                ];
                
                for (const selector of captionSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent && element.textContent.trim().length > 10) {
                        caption = element.textContent.trim();
                        break;
                    }
                }
            }
            
            // Method 3: Search in page scripts for JSON data
            if (!caption) {
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    if (script.textContent && script.textContent.includes('"caption"')) {
                        try {
                            // Try to extract caption from JSON data
                            const matches = script.textContent.match(/"caption":\s*"([^"]+)"/);
                            if (matches && matches[1]) {
                                caption = matches[1];
                                break;
                            }
                        } catch (e) {
                            // Continue searching
                        }
                    }
                }
            }
            
            post.caption = caption;
            
            // Extract hashtags and mentions from caption
            if (caption) {
                post.hashtags = [...new Set((caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
                post.mentions = [...new Set((caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
            } else {
                post.hashtags = [];
                post.mentions = [];
            }
            
            // Get post owner information
            const ownerSelectors = [
                'article a[role="link"]',
                'header a',
                'main article a'
            ];
            
            for (const selector of ownerSelectors) {
                const ownerLink = document.querySelector(selector);
                if (ownerLink) {
                    const href = ownerLink.getAttribute('href');
                    if (href && href.startsWith('/') && !href.includes('/p/')) {
                        post.ownerUsername = href.replace('/', '') || '';
                        break;
                    }
                }
            }
            
            // Try to extract engagement metrics from various sources
            let likeCount = 0;
            let commentCount = 0;
            
            // Method 1: Look for aria-labels
            const buttons = document.querySelectorAll('button, span');
            for (const btn of buttons) {
                const ariaLabel = btn.getAttribute('aria-label') || '';
                const text = btn.textContent || '';
                
                // Check for likes
                if (ariaLabel.includes('like') || text.includes('like')) {
                    const likeMatch = (ariaLabel + ' ' + text).match(/(\d+(?:,\d+)*)\s*like/i);
                    if (likeMatch) {
                        likeCount = parseInt(likeMatch[1].replace(/,/g, ''));
                    }
                }
                
                // Check for comments
                if (ariaLabel.includes('comment') || text.includes('comment')) {
                    const commentMatch = (ariaLabel + ' ' + text).match(/(\d+(?:,\d+)*)\s*comment/i);
                    if (commentMatch) {
                        commentCount = parseInt(commentMatch[1].replace(/,/g, ''));
                    }
                }
            }
            
            // Method 2: Look in page content for numbers
            const pageText = document.body.textContent || '';
            if (likeCount === 0) {
                const likeMatches = pageText.match(/(\d+(?:,\d+)*)\s*likes?/gi);
                if (likeMatches && likeMatches.length > 0) {
                    likeCount = parseInt(likeMatches[0].replace(/[^\d]/g, ''));
                }
            }
            
            post.likesCount = likeCount;
            post.commentsCount = commentCount;
            
            // Extract media information
            const images = [];
            const videos = [];
            
            // Get images
            const imgElements = document.querySelectorAll('img[src*="instagram.com"], img[src*="cdninstagram.com"]');
            for (const img of imgElements) {
                if (img.src && img.src.includes('instagram') && !img.src.includes('profile')) {
                    images.push({
                        url: img.src,
                        alt: img.alt || ''
                    });
                }
            }
            
            // Get videos
            const videoElements = document.querySelectorAll('video');
            for (const video of videoElements) {
                if (video.src) {
                    videos.push({
                        url: video.src,
                        poster: video.poster || ''
                    });
                }
            }
            
            post.images = images.slice(0, 10); // Limit to 10 images
            post.videos = videos.slice(0, 5);  // Limit to 5 videos
            
            // Determine post type
            if (videos.length > 0) {
                post.type = videos.length === 1 ? 'video' : 'carousel_video';
            } else if (images.length > 1) {
                post.type = 'carousel_album';
            } else {
                post.type = 'image';
            }
            
            // Try to extract timestamp
            const timeElements = document.querySelectorAll('time[datetime], time[title]');
            for (const timeEl of timeElements) {
                const datetime = timeEl.getAttribute('datetime') || timeEl.getAttribute('title');
                if (datetime) {
                    post.timestamp = datetime;
                    break;
                }
            }
            
            // Extract location if available
            const locationSelectors = [
                'a[href*="/explore/locations/"]',
                'div[data-testid="location"]'
            ];
            
            for (const selector of locationSelectors) {
                const locationElement = document.querySelector(selector);
                if (locationElement) {
                    post.locationName = locationElement.textContent?.trim();
                    const href = locationElement.getAttribute('href');
                    if (href) {
                        const locationId = href.match(/\/explore\/locations\/(\d+)/)?.[1];
                        if (locationId) {
                            post.locationId = locationId;
                        }
                    }
                    break;
                }
            }
            
            return post;
        }, postUrl);
        
        // Log what we found for debugging
        console.log(`Extracted post data:`, {
            url: postData.url,
            caption: postData.caption ? `${postData.caption.substring(0, 50)}...` : 'No caption',
            likesCount: postData.likesCount,
            commentsCount: postData.commentsCount,
            imagesCount: postData.images?.length || 0,
            videosCount: postData.videos?.length || 0
        });
        
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
        
        // Wait for the page to load and try multiple selectors
        await page.waitForTimeout(3000);
        
        // Modern Instagram uses different selectors - try multiple approaches
        const postSelectors = [
            'article a[href*="/p/"]',
            'a[href*="/p/"][role="link"]',
            'div[role="button"] a[href*="/p/"]',
            'main a[href*="/p/"]'
        ];
        
        let postLinks = [];
        
        // Try each selector
        for (const selector of postSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                const links = await page.$eval(selector, elements => 
                    elements.map(el => el.href).filter(href => href && href.includes('/p/'))
                );
                if (links.length > 0) {
                    postLinks = [...new Set([...postLinks, ...links])];
                    console.log(`Found ${links.length} posts using selector: ${selector}`);
                    break;
                }
            } catch (e) {
                console.log(`Selector ${selector} failed: ${e.message}`);
                continue;
            }
        }
        
        // If no posts found with selectors, try scrolling and extracting from page content
        if (postLinks.length === 0) {
            console.log('No posts found with selectors, trying alternative method...');
            
            // Scroll to load content
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(2000);
            }
            
            // Extract post URLs from page content
            const pageContent = await page.content();
            const postMatches = pageContent.match(/\/p\/[A-Za-z0-9_-]+/g);
            if (postMatches) {
                postLinks = [...new Set(postMatches.map(match => `https://www.instagram.com${match}/`))];
                console.log(`Found ${postLinks.length} posts from page content`);
            }
        }
        
        // Additional scroll to load more posts if needed
        if (postLinks.length > 0 && postLinks.length < maxPosts) {
            let scrollAttempts = 0;
            const maxScrollAttempts = 5;
            
            while (postLinks.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(3000);
                
                // Try to get more links
                for (const selector of postSelectors) {
                    try {
                        const newLinks = await page.$eval(selector, elements => 
                            elements.map(el => el.href).filter(href => href && href.includes('/p/'))
                        );
                        postLinks = [...new Set([...postLinks, ...newLinks])];
                    } catch (e) {
                        // Continue to next selector
                    }
                }
                
                scrollAttempts++;
            }
        }
        
        return postLinks.slice(0, maxPosts);
    } catch (error) {
        console.log(`Error getting posts from profile ${username}:`, error.message);
        
        // Try a direct approach with page evaluation
        try {
            const postLinks = await page.evaluate(() => {
                const links = [];
                const anchors = document.querySelectorAll('a');
                anchors.forEach(anchor => {
                    if (anchor.href && anchor.href.includes('/p/')) {
                        links.push(anchor.href);
                    }
                });
                return [...new Set(links)];
            });
            
            console.log(`Fallback method found ${postLinks.length} posts`);
            return postLinks.slice(0, maxPosts);
        } catch (fallbackError) {
            console.log('Fallback method also failed:', fallbackError.message);
            return [];
        }
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