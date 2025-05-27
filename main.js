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

// Helper function to extract post/reel data
const extractPostData = async (page, contentUrl) => {
    try {
        // Wait for content to load with longer timeout
        await page.waitForTimeout(5000);
        
        // Determine if this is a reel or regular post
        const isReel = contentUrl.includes('/reel/');
        
        const postData = await page.evaluate((url, isReel) => {
            const post = {};
            
            // Basic information
            post.url = url;
            post.isReel = isReel;
            
            if (isReel) {
                post.shortcode = url.split('/reel/')[1]?.split('/')[0] || '';
                post.type = 'reel';
            } else {
                post.shortcode = url.split('/p/')[1]?.split('/')[0] || '';
            }
            
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
                    'main article span',
                    'div[data-testid="media-caption"]'
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
                    if (href && href.startsWith('/') && !href.includes('/p/') && !href.includes('/reel/')) {
                        post.ownerUsername = href.replace('/', '') || '';
                        break;
                    }
                }
            }
            
            // Extract engagement metrics
            let likeCount = 0;
            let commentCount = 0;
            let viewCount = 0;
            
            // Get all buttons and spans for engagement data
            const buttons = document.querySelectorAll('button, span, div');
            for (const btn of buttons) {
                const ariaLabel = btn.getAttribute('aria-label') || '';
                const text = btn.textContent || '';
                const combinedText = (ariaLabel + ' ' + text).toLowerCase();
                
                // Check for likes
                if (combinedText.includes('like') && !combinedText.includes('unlike')) {
                    const likeMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?[kmb]?)\s*like/i);
                    if (likeMatch) {
                        let likes = likeMatch[1].replace(/,/g, '');
                        if (likes.includes('k')) {
                            likeCount = Math.floor(parseFloat(likes) * 1000);
                        } else if (likes.includes('m')) {
                            likeCount = Math.floor(parseFloat(likes) * 1000000);
                        } else if (likes.includes('b')) {
                            likeCount = Math.floor(parseFloat(likes) * 1000000000);
                        } else {
                            likeCount = parseInt(likes) || 0;
                        }
                    }
                }
                
                // Check for comments
                if (combinedText.includes('comment')) {
                    const commentMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?[kmb]?)\s*comment/i);
                    if (commentMatch) {
                        let comments = commentMatch[1].replace(/,/g, '');
                        if (comments.includes('k')) {
                            commentCount = Math.floor(parseFloat(comments) * 1000);
                        } else if (comments.includes('m')) {
                            commentCount = Math.floor(parseFloat(comments) * 1000000);
                        } else if (comments.includes('b')) {
                            commentCount = Math.floor(parseFloat(comments) * 1000000000);
                        } else {
                            commentCount = parseInt(comments) || 0;
                        }
                    }
                }
                
                // Check for views (especially important for reels)
                if (combinedText.includes('view') || combinedText.includes('play')) {
                    const viewMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?[kmb]?)\s*(?:view|play)/i);
                    if (viewMatch) {
                        let views = viewMatch[1].replace(/,/g, '');
                        if (views.includes('k')) {
                            viewCount = Math.floor(parseFloat(views) * 1000);
                        } else if (views.includes('m')) {
                            viewCount = Math.floor(parseFloat(views) * 1000000);
                        } else if (views.includes('b')) {
                            viewCount = Math.floor(parseFloat(views) * 1000000000);
                        } else {
                            viewCount = parseInt(views) || 0;
                        }
                    }
                }
            }
            
            // For reels, also search page text more aggressively for view count
            if (isReel && viewCount === 0) {
                const pageText = document.body.textContent || '';
                const viewPatterns = [
                    /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*views?/gi,
                    /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*plays?/gi,
                    /(\d+[,.]?\d*[KMB]?)\s*views?/gi
                ];
                
                for (const pattern of viewPatterns) {
                    const matches = pageText.match(pattern);
                    if (matches && matches.length > 0) {
                        const viewText = matches[0];
                        const numberMatch = viewText.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/i);
                        if (numberMatch) {
                            let views = numberMatch[1].replace(/,/g, '').toLowerCase();
                            if (views.includes('k')) {
                                viewCount = Math.floor(parseFloat(views) * 1000);
                            } else if (views.includes('m')) {
                                viewCount = Math.floor(parseFloat(views) * 1000000);
                            } else if (views.includes('b')) {
                                viewCount = Math.floor(parseFloat(views) * 1000000000);
                            } else {
                                viewCount = parseInt(views) || 0;
                            }
                            
                            if (viewCount > 0) break;
                        }
                    }
                }
            }
            
            post.likesCount = likeCount;
            post.commentsCount = commentCount;
            post.viewCount = viewCount;
            
            // Extract media information with reel-specific selectors
            const images = [];
            const videos = [];
            
            if (isReel) {
                // Reel-specific video selectors
                const reelVideoSelectors = [
                    'video[playsinline]',
                    'div[role="button"] video',
                    'article video',
                    'main video'
                ];
                
                for (const selector of reelVideoSelectors) {
                    const videoElements = document.querySelectorAll(selector);
                    for (const video of videoElements) {
                        const videoUrl = video.src || video.querySelector('source')?.src;
                        if (videoUrl) {
                            videos.push({
                                url: videoUrl,
                                poster: video.poster || '',
                                duration: video.duration || 0,
                                width: video.videoWidth || video.width,
                                height: video.videoHeight || video.height
                            });
                        }
                    }
                    if (videos.length > 0) break;
                }
                
                post.type = 'reel';
            } else {
                // Regular post image/video extraction
                const imageSelectors = [
                    'article img[src*="scontent"]',
                    'article img[src*="cdninstagram"]', 
                    'article img[src*="instagram.com"]',
                    'div[role="button"] img',
                    'main img[src*="scontent"]'
                ];
                
                for (const selector of imageSelectors) {
                    const imgElements = document.querySelectorAll(selector);
                    for (const img of imgElements) {
                        if (img.src && 
                            (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                            !img.src.includes('profile') && 
                            !img.src.includes('story') &&
                            img.width > 100 && img.height > 100) {
                            images.push({
                                url: img.src,
                                alt: img.alt || '',
                                width: img.naturalWidth || img.width,
                                height: img.naturalHeight || img.height
                            });
                        }
                    }
                    if (images.length > 0) break;
                }
                
                // Check for videos in regular posts
                const videoElements = document.querySelectorAll('article video, main video');
                for (const video of videoElements) {
                    const videoUrl = video.src || video.querySelector('source')?.src;
                    if (videoUrl) {
                        videos.push({
                            url: videoUrl,
                            poster: video.poster || '',
                            duration: video.duration || 0,
                            width: video.videoWidth || video.width,
                            height: video.videoHeight || video.height
                        });
                    }
                }
                
                // Determine post type
                if (videos.length > 0) {
                    post.type = videos.length === 1 ? 'video' : 'carousel_video';
                } else if (images.length > 1) {
                    post.type = 'carousel_album';
                } else {
                    post.type = 'image';
                }
            }
            
            post.images = images.slice(0, 10);
            post.videos = videos.slice(0, 5);
            
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
        }, contentUrl, isReel);
        
        // Log what we found for debugging
        console.log(`Extracted ${isReel ? 'reel' : 'post'} data:`, {
            url: postData.url,
            type: postData.type,
            isReel: postData.isReel,
            caption: postData.caption ? `${postData.caption.substring(0, 50)}...` : 'No caption',
            likesCount: postData.likesCount,
            commentsCount: postData.commentsCount,
            viewCount: postData.viewCount,
            imagesCount: postData.images?.length || 0,
            videosCount: postData.videos?.length || 0
        });
        
        return postData;
    } catch (error) {
        console.log(`Error extracting data from ${contentUrl}:`, error.message);
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

// Helper function to get posts AND reels from profile
const getProfilePosts = async (page, username, maxPosts) => {
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle' });
        
        // Wait for the page to load and try multiple selectors
        await page.waitForTimeout(3000);
        
        // Modern Instagram uses different selectors for posts and reels
        const contentSelectors = [
            'article a[href*="/p/"]',        // Regular posts
            'article a[href*="/reel/"]',     // Reels
            'a[href*="/p/"][role="link"]',   // Posts with role
            'a[href*="/reel/"][role="link"]', // Reels with role
            'div[role="button"] a[href*="/p/"]', // Posts in buttons
            'div[role="button"] a[href*="/reel/"]', // Reels in buttons
            'main a[href*="/p/"]',           // Posts in main
            'main a[href*="/reel/"]'         // Reels in main
        ];
        
        let contentLinks = [];
        
        // Try each selector
        for (const selector of contentSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                const links = await page.$$eval(selector, elements => 
                    elements.map(el => el.href).filter(href => 
                        href && (href.includes('/p/') || href.includes('/reel/'))
                    )
                );
                if (links.length > 0) {
                    contentLinks = [...new Set([...contentLinks, ...links])];
                    console.log(`Found ${links.length} content items using selector: ${selector}`);
                }
            } catch (e) {
                console.log(`Selector ${selector} failed: ${e.message}`);
                continue;
            }
        }
        
        // If no content found with selectors, try alternative method
        if (contentLinks.length === 0) {
            console.log('No content found with selectors, trying alternative method...');
            
            // Scroll to load content
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(2000);
            }
            
            // Extract URLs from page content
            const pageContent = await page.content();
            const postMatches = pageContent.match(/\/(p|reel)\/[A-Za-z0-9_-]+/g);
            if (postMatches) {
                contentLinks = [...new Set(postMatches.map(match => `https://www.instagram.com${match}/`))];
                console.log(`Found ${contentLinks.length} content items from page content`);
            }
        }
        
        // Additional scroll to load more content if needed
        if (contentLinks.length > 0 && contentLinks.length < maxPosts) {
            let scrollAttempts = 0;
            const maxScrollAttempts = 5;
            
            while (contentLinks.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(3000);
                
                // Try to get more links
                for (const selector of contentSelectors) {
                    try {
                        const newLinks = await page.$$eval(selector, elements => 
                            elements.map(el => el.href).filter(href => 
                                href && (href.includes('/p/') || href.includes('/reel/'))
                            )
                        );
                        contentLinks = [...new Set([...contentLinks, ...newLinks])];
                    } catch (e) {
                        // Continue to next selector
                    }
                }
                
                scrollAttempts++;
            }
        }
        
        return contentLinks.slice(0, maxPosts);
    } catch (error) {
        console.log(`Error getting content from profile ${username}:`, error.message);
        
        // Try a direct approach with page evaluation
        try {
            const contentLinks = await page.evaluate(() => {
                const links = [];
                const anchors = document.querySelectorAll('a');
                anchors.forEach(anchor => {
                    if (anchor.href && (anchor.href.includes('/p/') || anchor.href.includes('/reel/'))) {
                        links.push(anchor.href);
                    }
                });
                return [...new Set(links)];
            });
            
            console.log(`Fallback method found ${contentLinks.length} content items`);
            return contentLinks.slice(0, maxPosts);
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
                // Handle profile page - get post AND reel URLs
                const username = url.replace('https://www.instagram.com/', '').replace('/', '');
                const contentUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${contentUrls.length} content items for ${username} (posts and reels)`);
                
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