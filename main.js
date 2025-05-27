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
        // Wait for content to load and check if page loaded properly
        await page.waitForTimeout(3000);
        
        // Check if we hit a login wall or error page
        const loginCheck = await page.$('input[name="username"], div:has-text("Log in"), div:has-text("Sign up")');
        if (loginCheck) {
            console.log('Hit login wall, trying to continue anyway...');
            await page.waitForTimeout(2000);
        }
        
        // Wait for main content
        try {
            await page.waitForSelector('main, article', { timeout: 10000 });
        } catch (e) {
            console.log('Main content not found, proceeding with extraction...');
        }
        
        // Determine if this is a reel or regular post
        const isReel = contentUrl.includes('/reel/');
        
        const postData = await page.evaluate(({ url, isReel }) => {
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
            
            // Try multiple approaches to get clean caption (without engagement metrics)
            let caption = '';
            
            // Method 1: Search in page scripts for clean caption first (most reliable)
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                if (script.textContent && script.textContent.includes('"edge_media_to_caption"')) {
                    try {
                        // Look for the actual caption in Instagram's JSON data
                        const captionMatch = script.textContent.match(/"edge_media_to_caption":\s*{\s*"edges":\s*\[\s*{\s*"node":\s*{\s*"text":\s*"([^"]+)"/);
                        if (captionMatch && captionMatch[1]) {
                            caption = captionMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            break;
                        }
                    } catch (e) {
                        // Continue searching
                    }
                }
                
                // Also try simpler caption patterns
                if (!caption && script.textContent && script.textContent.includes('"caption"')) {
                    try {
                        const simpleCaptionMatch = script.textContent.match(/"caption":\s*"([^"]+)"/);
                        if (simpleCaptionMatch && simpleCaptionMatch[1] && 
                            simpleCaptionMatch[1] !== 'Contact Uploading & Non-Users' &&
                            simpleCaptionMatch[1].length > 5) {
                            caption = simpleCaptionMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            break;
                        }
                    } catch (e) {
                        // Continue searching
                    }
                }
            }
            
            // Method 2: Try to find actual caption text elements (avoid engagement elements)
            if (!caption) {
                const captionSelectors = [
                    'article div[data-testid="post-text"] span',
                    'article h1',
                    'span[dir="auto"]:not([aria-label]):not([role="button"])',
                    'article span:not([aria-label*="like"]):not([aria-label*="comment"]):not([aria-label*="view"])'
                ];
                
                for (const selector of captionSelectors) {
                    const elements = document.querySelectorAll(selector);
                    for (const element of elements) {
                        const text = element.textContent?.trim();
                        if (text && 
                            text.length > 15 && 
                            !text.match(/^\d+[KMB]?\s*(like|comment|view)/i) && // Exclude engagement text
                            !text.match(/^\d+,\d+/) && // Exclude comma-separated numbers
                            !text.includes('•') && // Exclude metadata
                            !text.includes(' on ') && // Exclude date strings
                            (text.includes('#') || text.includes('@') || text.split(' ').length > 3)) { // Likely caption
                            caption = text;
                            break;
                        }
                    }
                    if (caption) break;
                }
            }
            
            // Method 3: Clean meta description as last resort
            if (!caption) {
                const metaDesc = document.querySelector('meta[property="og:description"]');
                if (metaDesc) {
                    let metaText = metaDesc.getAttribute('content') || '';
                    // Remove engagement metrics and metadata from meta description
                    metaText = metaText.replace(/^\d+[KMB]?\s*(likes?|comments?|views?)[^"]*"\s*-\s*/i, '');
                    metaText = metaText.replace(/^\d+,\d+[^-]*-\s*/i, '');
                    metaText = metaText.replace(/\s*on\s+(Instagram|May|June|July|August|September|October|November|December)\s+\d+.*$/i, '');
                    metaText = metaText.replace(/^[^"]*"\s*-\s*/, ''); // Remove quoted usernames
                    if (metaText && metaText.length > 10) {
                        caption = metaText.trim().replace(/^"|"$/g, ''); // Remove surrounding quotes
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
            
            // Get post owner information - more reliable extraction
            let ownerUsername = '';
            
            // Method 1: Extract from URL pattern
            const urlParts = url.split('/');
            const urlIndex = urlParts.findIndex(part => part === 'p' || part === 'reel');
            if (urlIndex > 0) {
                // Look backwards in URL for username
                for (let i = urlIndex - 1; i >= 0; i--) {
                    if (urlParts[i] && urlParts[i] !== 'www.instagram.com' && urlParts[i] !== 'instagram.com' && urlParts[i] !== '') {
                        ownerUsername = urlParts[i];
                        break;
                    }
                }
            }
            
            // Method 2: Look for username in JSON data
            if (!ownerUsername) {
                for (const script of scripts) {
                    if (script.textContent && script.textContent.includes('"username"')) {
                        try {
                            const usernameMatch = script.textContent.match(/"username":\s*"([^"]+)"/);
                            if (usernameMatch && usernameMatch[1] && !usernameMatch[1].includes('instagram')) {
                                ownerUsername = usernameMatch[1];
                                break;
                            }
                        } catch (e) {
                            // Continue searching
                        }
                    }
                }
            }
            
            // Method 3: Look in DOM elements
            if (!ownerUsername) {
                const ownerSelectors = [
                    'article a[role="link"]',
                    'header a[href^="/"]',
                    'main article a[href^="/"]'
                ];
                
                for (const selector of ownerSelectors) {
                    const ownerLink = document.querySelector(selector);
                    if (ownerLink) {
                        const href = ownerLink.getAttribute('href');
                        if (href && href.startsWith('/') && !href.includes('/p/') && !href.includes('/reel/')) {
                            const username = href.replace('/', '').split('/')[0];
                            if (username && username.length > 0) {
                                ownerUsername = username;
                                break;
                            }
                        }
                    }
                }
            }
            
            post.ownerUsername = ownerUsername;
            
            // Extract engagement metrics with better number parsing
            let likeCount = 0;
            let commentCount = 0;
            let viewCount = 0;
            
            // Method 1: Try to extract from JSON data first (most accurate)
            for (const script of scripts) {
                if (script.textContent && script.textContent.includes('edge_media_preview_like')) {
                    try {
                        // Extract likes from JSON
                        const likeMatch = script.textContent.match(/"edge_media_preview_like":\s*{\s*"count":\s*(\d+)/);
                        if (likeMatch && likeMatch[1]) {
                            likeCount = parseInt(likeMatch[1]);
                        }
                        
                        // Extract comments from JSON
                        const commentMatch = script.textContent.match(/"edge_media_to_parent_comment":\s*{\s*"count":\s*(\d+)/);
                        if (commentMatch && commentMatch[1]) {
                            commentCount = parseInt(commentMatch[1]);
                        }
                        
                        // Extract views from JSON (for reels/videos)
                        if (isReel) {
                            const viewPatterns = [
                                /"video_view_count":\s*(\d+)/,
                                /"play_count":\s*(\d+)/,
                                /"view_count":\s*(\d+)/
                            ];
                            
                            for (const pattern of viewPatterns) {
                                const viewMatch = script.textContent.match(pattern);
                                if (viewMatch && viewMatch[1]) {
                                    viewCount = parseInt(viewMatch[1]);
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        // Continue to DOM parsing
                    }
                    break;
                }
            }
            
            // Method 2: DOM-based extraction if JSON method failed
            if (likeCount === 0 || commentCount === 0 || (isReel && viewCount === 0)) {
                const buttons = document.querySelectorAll('button, span, div, section');
                
                for (const element of buttons) {
                    const ariaLabel = element.getAttribute('aria-label') || '';
                    const text = element.textContent || '';
                    const title = element.getAttribute('title') || '';
                    const combinedText = (ariaLabel + ' ' + text + ' ' + title).toLowerCase();
                    
                    // Parse likes with better number handling
                    if (likeCount === 0 && (combinedText.includes('like') && !combinedText.includes('unlike'))) {
                        const likeMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?\s*like/i);
                        if (likeMatch) {
                            likeCount = parseEngagementNumber(likeMatch[1]);
                        }
                    }
                    
                    // Parse comments with better number handling
                    if (commentCount === 0 && combinedText.includes('comment')) {
                        const commentMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?\s*comment/i);
                        if (commentMatch) {
                            commentCount = parseEngagementNumber(commentMatch[1]);
                        }
                    }
                    
                    // Parse views for reels with better number handling
                    if (isReel && viewCount === 0 && (combinedText.includes('view') || combinedText.includes('play'))) {
                        const viewMatch = combinedText.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?\s*(?:view|play)/i);
                        if (viewMatch) {
                            viewCount = parseEngagementNumber(viewMatch[1]);
                        }
                    }
                }
            }
            
            // Method 3: Search page text for reels view count if still not found
            if (isReel && viewCount === 0) {
                const pageText = document.body.textContent || '';
                const viewPatterns = [
                    /(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?\s*views?/gi,
                    /(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?\s*plays?/gi
                ];
                
                for (const pattern of viewPatterns) {
                    const matches = pageText.match(pattern);
                    if (matches && matches.length > 0) {
                        // Take the first reasonable number found
                        for (const match of matches) {
                            const numberMatch = match.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*[kmb]?/i);
                            if (numberMatch && numberMatch[1]) {
                                const parsedNumber = parseEngagementNumber(numberMatch[1]);
                                if (parsedNumber > 10) { // Ignore very small numbers that might be false positives
                                    viewCount = parsedNumber;
                                    break;
                                }
                            }
                        }
                        if (viewCount > 0) break;
                    }
                }
            }
            
            // Helper function to parse engagement numbers correctly
            function parseEngagementNumber(numStr) {
                if (!numStr) return 0;
                
                // Remove commas and convert to lowercase for processing
                let cleanNum = numStr.replace(/,/g, '').toLowerCase().trim();
                
                // Handle K, M, B suffixes
                if (cleanNum.includes('k')) {
                    return Math.floor(parseFloat(cleanNum.replace('k', '')) * 1000);
                } else if (cleanNum.includes('m')) {
                    return Math.floor(parseFloat(cleanNum.replace('m', '')) * 1000000);
                } else if (cleanNum.includes('b')) {
                    return Math.floor(parseFloat(cleanNum.replace('b', '')) * 1000000000);
                } else {
                    return parseInt(cleanNum) || 0;
                }
            }
            
            post.likesCount = likeCount;
            post.commentsCount = commentCount;
            post.viewCount = viewCount;
            
            // Extract media information with reel-specific selectors
            const images = [];
            const videos = [];
            
            if (isReel) {
                // Reel-specific video selectors with better detection
                const reelVideoSelectors = [
                    'video[playsinline]',
                    'div[role="button"] video',
                    'article video',
                    'main video',
                    'video[src]',
                    'video source'
                ];
                
                // Method 1: Try JSON data extraction for video URLs
                for (const script of scripts) {
                    if (script.textContent && script.textContent.includes('"video_url"')) {
                        try {
                            const videoMatches = script.textContent.match(/"video_url":\s*"([^"]+)"/g);
                            if (videoMatches) {
                                for (const match of videoMatches) {
                                    const urlMatch = match.match(/"video_url":\s*"([^"]+)"/);
                                    if (urlMatch && urlMatch[1]) {
                                        const cleanUrl = urlMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                                        videos.push({
                                            url: cleanUrl,
                                            source: 'script',
                                            quality: 'high'
                                        });
                                    }
                                }
                            }
                        } catch (e) {
                            // Continue to DOM extraction
                        }
                        if (videos.length > 0) break;
                    }
                }
                
                // Method 2: DOM-based video extraction if script method failed
                if (videos.length === 0) {
                    for (const selector of reelVideoSelectors) {
                        const videoElements = document.querySelectorAll(selector);
                        for (const video of videoElements) {
                            const videoUrl = video.src || video.querySelector('source')?.src;
                            if (videoUrl && videoUrl.startsWith('blob:') === false) {
                                videos.push({
                                    url: videoUrl,
                                    poster: video.poster || '',
                                    duration: video.duration || 0,
                                    width: video.videoWidth || video.width,
                                    height: video.videoHeight || video.height,
                                    source: 'dom'
                                });
                            }
                        }
                        if (videos.length > 0) break;
                    }
                }
                
                post.type = 'reel';
            } else {
                // Regular post image/video extraction with more aggressive approach
                
                // Method 1: Try to find images in JSON data first (most reliable for carousel posts)
                let foundImages = false;
                for (const script of scripts) {
                    if (script.textContent && script.textContent.includes('edge_sidecar_to_children')) {
                        try {
                            // Look for carousel/sidecar posts with multiple images
                            const sidecarMatch = script.textContent.match(/"edge_sidecar_to_children":\s*{\s*"edges":\s*\[([^\]]+)\]/);
                            if (sidecarMatch) {
                                const edges = sidecarMatch[1];
                                const displayUrls = edges.match(/"display_url":\s*"([^"]+)"/g);
                                if (displayUrls) {
                                    for (const match of displayUrls) {
                                        const urlMatch = match.match(/"display_url":\s*"([^"]+)"/);
                                        if (urlMatch && urlMatch[1]) {
                                            const cleanUrl = urlMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                                            if ((cleanUrl.includes('scontent') || cleanUrl.includes('cdninstagram')) && !cleanUrl.includes('s150x150')) {
                                                images.push({
                                                    url: cleanUrl,
                                                    alt: '',
                                                    source: 'carousel',
                                                    quality: 'high'
                                                });
                                                foundImages = true;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            // Continue searching
                        }
                    }
                    
                    // Also look for single post display_url if carousel not found
                    if (!foundImages && script.textContent.includes('display_url')) {
                        try {
                            const urlMatches = script.textContent.match(/"display_url":\s*"([^"]+)"/g);
                            if (urlMatches) {
                                for (const match of urlMatches) {
                                    const urlMatch = match.match(/"display_url":\s*"([^"]+)"/);
                                    if (urlMatch && urlMatch[1]) {
                                        const cleanUrl = urlMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                                        if ((cleanUrl.includes('scontent') || cleanUrl.includes('cdninstagram')) && !cleanUrl.includes('s150x150')) {
                                            images.push({
                                                url: cleanUrl,
                                                alt: '',
                                                source: 'script',
                                                quality: 'high'
                                            });
                                            foundImages = true;
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            // Continue searching
                        }
                    }
                    if (foundImages) break;
                }
                
                // Method 2: DOM-based image extraction if script method failed
                if (!foundImages) {
                    const imageSelectors = [
                        'article img[src*="scontent"]',
                        'article img[src*="cdninstagram"]', 
                        'div[role="button"] img[src*="scontent"]',
                        'main img[src*="scontent"]',
                        'img[style*="object-fit"][src*="scontent"]',
                        'article div img[src*="instagram"]',
                        'img[src*="scontent"]:not([src*="s150x150"])',  // Exclude small thumbnails
                        'img[src*="cdninstagram"]:not([src*="profile"])'
                    ];
                    
                    for (const selector of imageSelectors) {
                        const imgElements = document.querySelectorAll(selector);
                        for (const img of imgElements) {
                            if (img.src && 
                                (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                                !img.src.includes('profile') && 
                                !img.src.includes('story') &&
                                !img.src.includes('s150x150') && // Skip small thumbnails
                                !img.src.includes('s240x240') && // Skip medium thumbnails
                                (img.naturalWidth > 300 || img.width > 300)) { // Only get decent sized images
                                
                                images.push({
                                    url: img.src,
                                    alt: img.alt || '',
                                    width: img.naturalWidth || img.width,
                                    height: img.naturalHeight || img.height,
                                    source: 'dom'
                                });
                                foundImages = true;
                            }
                        }
                        if (foundImages) break;
                    }
                }
                
                // Method 3: Background image extraction as fallback
                if (!foundImages) {
                    const bgElements = document.querySelectorAll('div[style*="background-image"], span[style*="background-image"]');
                    for (const el of bgElements) {
                        const style = el.getAttribute('style');
                        const urlMatch = style.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/);
                        if (urlMatch && urlMatch[1] && 
                            (urlMatch[1].includes('scontent') || urlMatch[1].includes('cdninstagram')) &&
                            !urlMatch[1].includes('s150x150')) {
                            images.push({
                                url: urlMatch[1],
                                alt: '',
                                source: 'background'
                            });
                            foundImages = true;
                        }
                    }
                }
                
                // Method 4: Extract all images if still nothing found and filter later
                if (!foundImages) {
                    const allImages = document.querySelectorAll('img');
                    for (const img of allImages) {
                        if (img.src && 
                            (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                            !img.src.includes('profile') && 
                            !img.src.includes('story') &&
                            img.width > 200 && img.height > 200) {
                            
                            images.push({
                                url: img.src,
                                alt: img.alt || '',
                                width: img.naturalWidth || img.width,
                                height: img.naturalHeight || img.height,
                                source: 'fallback'
                            });
                        }
                    }
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
            
            // Remove duplicates and ensure we have actual URLs
            post.images = [...new Map(images.map(img => [img.url, img])).values()].slice(0, 10);
            post.videos = [...new Map(videos.map(vid => [vid.url, vid])).values()].slice(0, 5);
            
            // Debug logging
            console.log(`Debug - Found ${post.images.length} images, ${post.videos.length} videos for ${isReel ? 'reel' : 'post'}`);
            if (post.images.length > 0) {
                console.log('Sample image URL:', post.images[0].url.substring(0, 80) + '...');
            }
            if (post.videos.length > 0) {
                console.log('Sample video URL:', post.videos[0].url.substring(0, 80) + '...');
            }
            
            // Extract timestamp more reliably
            let timestamp = '';
            
            // Method 1: Look in JSON data for timestamp
            for (const script of scripts) {
                if (script.textContent && script.textContent.includes('"taken_at_timestamp"')) {
                    try {
                        const timestampMatch = script.textContent.match(/"taken_at_timestamp":\s*(\d+)/);
                        if (timestampMatch && timestampMatch[1]) {
                            timestamp = new Date(parseInt(timestampMatch[1]) * 1000).toISOString();
                            break;
                        }
                    } catch (e) {
                        // Continue searching
                    }
                }
            }
            
            // Method 2: Look for datetime attributes in DOM
            if (!timestamp) {
                const timeElements = document.querySelectorAll('time[datetime], time[title], [datetime]');
                for (const timeEl of timeElements) {
                    const datetime = timeEl.getAttribute('datetime') || timeEl.getAttribute('title');
                    if (datetime && datetime.includes('T')) {
                        timestamp = datetime;
                        break;
                    }
                }
            }
            
            post.timestamp = timestamp;
            
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
        }, { url: contentUrl, isReel });
        
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