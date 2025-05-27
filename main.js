// main.js - Instagram Post Scraper (Working 2025 Method)
import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { chromium } from 'playwright';

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
    maxRequestRetries = 3,
    requestHandlerTimeoutSecs = 60,
    maxConcurrency = 2, // Lower concurrency to avoid blocks
    dateFrom,
    dateTo
} = input;

const dataset = await Dataset.open();

// Helper function to extract Instagram data using multiple methods
const extractInstagramData = async (page, url) => {
    try {
        console.log(`Extracting data from: ${url}`);
        
        const isReel = url.includes('/reel/');
        const shortcode = isReel ? url.split('/reel/')[1]?.split('/')[0] : url.split('/p/')[1]?.split('/')[0];
        
        if (!shortcode) {
            throw new Error('Could not extract shortcode from URL');
        }
        
        // Navigate to the URL with realistic browser behavior
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
        });
        
        // Add random delay to mimic human behavior
        await page.waitForTimeout(2000 + Math.random() * 3000);
        
        // Try to scroll slightly to trigger content loading
        await page.evaluate(() => {
            window.scrollBy(0, Math.random() * 500);
        });
        
        await page.waitForTimeout(1000);
        
        // Extract data using multiple methods
        const postData = await page.evaluate(async ({ shortcode, isReel, url }) => {
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
            post.ownerUsername = urlParts[1] || '';
            
            console.log('Attempting to extract Instagram data...');
            
            // Method 1: Try to find Instagram's JSON data in script tags
            const scripts = document.querySelectorAll('script[type="application/ld+json"], script:not([src])');
            let foundInScript = false;
            
            for (const script of scripts) {
                try {
                    const content = script.textContent || script.innerHTML;
                    if (!content) continue;
                    
                    // Look for various JSON patterns
                    const patterns = [
                        // Pattern 1: window._sharedData
                        /window\._sharedData\s*=\s*({.+?});/,
                        // Pattern 2: require\("ProfilePageContainer"\)
                        /"ProfilePageContainer"[^}]+?"user":\s*({.+?}),/,
                        // Pattern 3: Direct shortcode_media
                        /"shortcode_media":\s*({.+?})(?=,"toast_content_on_load"|$)/,
                        // Pattern 4: GraphQL data
                        /"data":\s*{"shortcode_media":\s*({.+?})}(?=,"extensions")/
                    ];
                    
                    for (const pattern of patterns) {
                        const match = content.match(pattern);
                        if (match) {
                            try {
                                const data = JSON.parse(match[1]);
                                console.log('Found JSON data in scripts');
                                
                                // Check if this is user profile data
                                if (data.user && data.user.edge_owner_to_timeline_media) {
                                    console.log('Found profile data');
                                    return { profileData: data.user, foundInScript: true };
                                }
                                
                                // Check if this is post data
                                if (data.shortcode || data.__typename === 'GraphImage' || data.__typename === 'GraphVideo') {
                                    console.log('Found post data');
                                    
                                    // Extract caption
                                    if (data.edge_media_to_caption?.edges?.[0]?.node?.text) {
                                        post.caption = data.edge_media_to_caption.edges[0].node.text;
                                    }
                                    
                                    // Extract engagement
                                    post.likesCount = data.edge_media_preview_like?.count || 0;
                                    post.commentsCount = data.edge_media_to_parent_comment?.count || 0;
                                    post.viewCount = data.video_view_count || 0;
                                    
                                    // Extract timestamp
                                    if (data.taken_at_timestamp) {
                                        post.timestamp = new Date(data.taken_at_timestamp * 1000).toISOString();
                                    }
                                    
                                    // Extract owner
                                    if (data.owner?.username) {
                                        post.ownerUsername = data.owner.username;
                                    }
                                    
                                    // Extract location
                                    if (data.location) {
                                        post.locationName = data.location.name || '';
                                        post.locationId = data.location.id || '';
                                    }
                                    
                                    // Extract media
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
                                    
                                    // Handle carousel
                                    if (data.edge_sidecar_to_children?.edges) {
                                        post.images = [];
                                        post.videos = [];
                                        for (const edge of data.edge_sidecar_to_children.edges) {
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
                                    
                                    foundInScript = true;
                                    break;
                                }
                            } catch (parseError) {
                                continue;
                            }
                        }
                    }
                    
                    if (foundInScript) break;
                } catch (error) {
                    continue;
                }
            }
            
            // Method 2: Fallback to DOM extraction if script method failed
            if (!foundInScript || (!post.caption && !post.images.length && !post.videos.length)) {
                console.log('Script method failed, trying DOM extraction...');
                
                // Extract caption from meta tag
                if (!post.caption) {
                    const metaDesc = document.querySelector('meta[property="og:description"]');
                    if (metaDesc && metaDesc.content) {
                        let desc = metaDesc.content;
                        // Clean the description
                        desc = desc.replace(/^\d+[KMB]?\s*(likes?|comments?)[^"]*?"\s*-\s*[^"]*?\s*on\s*[^:]*?:\s*"?/, '');
                        desc = desc.replace(/"\s*$/, '');
                        if (desc.length > 20) {
                            post.caption = desc;
                        }
                    }
                }
                
                // Extract images from DOM
                if (post.images.length === 0) {
                    const imgElements = document.querySelectorAll('img[src]');
                    for (const img of imgElements) {
                        if (img.src && 
                            (img.src.includes('scontent') || img.src.includes('cdninstagram')) &&
                            !img.src.includes('profile') &&
                            !img.src.includes('s150x150') &&
                            img.naturalWidth > 300) {
                            post.images.push({
                                url: img.src,
                                width: img.naturalWidth || 0,
                                height: img.naturalHeight || 0,
                                source: 'dom'
                            });
                        }
                    }
                }
                
                // Extract videos from DOM
                if (post.videos.length === 0) {
                    const videoElements = document.querySelectorAll('video[src], video source');
                    for (const video of videoElements) {
                        const videoUrl = video.src || video.parentElement?.src;
                        if (videoUrl && !videoUrl.startsWith('blob:')) {
                            post.videos.push({
                                url: videoUrl,
                                width: video.videoWidth || 0,
                                height: video.videoHeight || 0,
                                source: 'dom'
                            });
                        }
                    }
                }
                
                // Extract engagement metrics from page text
                if (post.likesCount === 0 || post.commentsCount === 0) {
                    const pageText = document.body.textContent || '';
                    
                    // Extract likes
                    const likeMatches = pageText.match(/(\d+(?:,\d+)*)\s*likes?/i);
                    if (likeMatches) {
                        post.likesCount = parseInt(likeMatches[1].replace(/,/g, ''));
                    }
                    
                    // Extract comments
                    const commentMatches = pageText.match(/(\d+(?:,\d+)*)\s*comments?/i);
                    if (commentMatches) {
                        post.commentsCount = parseInt(commentMatches[1].replace(/,/g, ''));
                    }
                    
                    // Extract views for reels
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
        }, { shortcode, isReel, url });
        
        // Handle profile data if returned
        if (postData.profileData) {
            return { profileData: postData.profileData };
        }
        
        console.log(`Data extraction result:`, {
            caption: postData.caption ? `Found (${postData.caption.length} chars)` : 'Not found',
            images: postData.images.length,
            videos: postData.videos.length,
            likes: postData.likesCount,
            comments: postData.commentsCount,
            views: postData.viewCount
        });
        
        return postData;
        
    } catch (error) {
        console.log(`Error extracting data from ${url}:`, error.message);
        return null;
    }
};

// Helper function to get posts from profile
const getProfilePosts = async (page, username, maxPosts) => {
    try {
        const profileUrl = `https://www.instagram.com/${username}/`;
        console.log(`Loading profile: ${profileUrl}`);
        
        const result = await extractInstagramData(page, profileUrl);
        
        if (result && result.profileData) {
            const user = result.profileData;
            const posts = [];
            const mediaEdges = user.edge_owner_to_timeline_media?.edges || [];
            
            console.log(`Found ${mediaEdges.length} posts for ${username}`);
            
            // Extract URLs from the profile data
            const postUrls = mediaEdges.slice(0, maxPosts).map(edge => {
                const shortcode = edge.node.shortcode;
                const isReel = edge.node.__typename === 'GraphVideo' && edge.node.product_type === 'clips';
                return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
            });
            
            return postUrls;
        }
        
        // Fallback: try to extract post URLs from the page
        const postUrls = await page.evaluate(() => {
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
        
        console.log(`Fallback method found ${postUrls.length} URLs`);
        return postUrls.slice(0, maxPosts);
        
    } catch (error) {
        console.log(`Error getting profile posts for ${username}:`, error.message);
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
                '--disable-features=VizDisplayCompositor',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-images', // Faster loading
                '--disable-javascript-harmony-shipping',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection'
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
            // Set realistic headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            });
            
            if (url.includes('/p/') || url.includes('/reel/')) {
                // Handle individual post or reel
                const postData = await extractInstagramData(page, url);
                
                if (postData && !postData.profileData) {
                    // Apply date filters
                    if (dateFrom || dateTo) {
                        const postDate = new Date(postData.timestamp);
                        if (dateFrom && postDate < new Date(dateFrom)) return;
                        if (dateTo && postDate > new Date(dateTo)) return;
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
                const postUrls = await getProfilePosts(page, username, maxPostsPerProfile);
                
                log.info(`Found ${postUrls.length} content items for ${username}`);
                
                // Add content URLs to request queue
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

console.log(`Starting scraper with ${initialRequests.length} initial requests`);

await crawler.addRequests(initialRequests);
await crawler.run();

const datasetInfo = await dataset.getInfo();
console.log(`Scraping completed. Total items: ${datasetInfo.itemCount}`);

await Actor.exit();