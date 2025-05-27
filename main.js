// main.js - Instagram Post Scraper (CheerioCrawler 2025 Method)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import * as cheerio from 'cheerio';

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
    requestHandlerTimeoutSecs = 30,
    maxConcurrency = 3,
    dateFrom,
    dateTo
} = input;

const dataset = await Dataset.open();

// Helper function to extract Instagram data from HTML
const extractInstagramData = (html, url) => {
    try {
        console.log(`Extracting data from: ${url}`);
        
        const $ = cheerio.load(html);
        const isProfileUrl = !url.includes('/p/') && !url.includes('/reel/');
        
        if (isProfileUrl) {
            // Handle profile page
            const profileData = extractProfileData($, html, url);
            return profileData;
        } else {
            // Handle individual post/reel
            const postData = extractPostData($, html, url);
            return postData;
        }
    } catch (error) {
        console.log(`Error extracting data from ${url}:`, error.message);
        return null;
    }
};

// Extract profile data and post URLs
const extractProfileData = ($, html, url) => {
    console.log('Extracting profile data...');
    
    // Try to extract JSON data from script tags
    const scripts = $('script:not([src])');
    let profileData = null;
    let postUrls = [];
    
    scripts.each((i, script) => {
        const content = $(script).html();
        if (!content || content.length < 100) return;
        
        try {
            // Look for profile data patterns
            const patterns = [
                // Pattern 1: window._sharedData
                /window\._sharedData\s*=\s*({.+?});/,
                // Pattern 2: ProfilePage data
                /"ProfilePage"[^{]*"graphql":\s*{"user":\s*({.+?})}(?=,"toast_content_on_load"|,"extensions")/,
                // Pattern 3: User data with timeline
                /"user":\s*({[^{}]*"edge_owner_to_timeline_media"[^{}]*{[^}]+}[^}]*})/
            ];
            
            for (const pattern of patterns) {
                const match = content.match(pattern);
                if (match) {
                    try {
                        const data = JSON.parse(match[1]);
                        
                        let userData = null;
                        if (data.entry_data?.ProfilePage?.[0]?.graphql?.user) {
                            userData = data.entry_data.ProfilePage[0].graphql.user;
                        } else if (data.user) {
                            userData = data.user;
                        } else if (data.edge_owner_to_timeline_media) {
                            userData = data;
                        }
                        
                        if (userData && userData.edge_owner_to_timeline_media) {
                            const mediaEdges = userData.edge_owner_to_timeline_media.edges || [];
                            console.log(`Found ${mediaEdges.length} posts in profile data`);
                            
                            postUrls = mediaEdges.map(edge => {
                                const shortcode = edge.node.shortcode;
                                const isReel = edge.node.__typename === 'GraphVideo' && 
                                              edge.node.product_type === 'clips';
                                return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
                            });
                            
                            profileData = userData;
                            return false; // Break the loop
                        }
                    } catch (parseError) {
                        continue;
                    }
                }
            }
        } catch (error) {
            // Continue to next script
        }
    });
    
    // Fallback: extract post URLs from DOM
    if (postUrls.length === 0) {
        console.log('JSON extraction failed, trying DOM extraction...');
        
        const links = new Set();
        $('a[href*="/p/"], a[href*="/reel/"]').each((i, element) => {
            const href = $(element).attr('href');
            if (href && (href.includes('/p/') || href.includes('/reel/'))) {
                const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                links.add(fullUrl);
            }
        });
        
        postUrls = Array.from(links);
        console.log(`DOM extraction found ${postUrls.length} post URLs`);
    }
    
    return { postUrls, profileData };
};

// Extract individual post data
const extractPostData = ($, html, url) => {
    console.log('Extracting post data...');
    
    const isReel = url.includes('/reel/');
    const shortcode = isReel ? 
        url.split('/reel/')[1]?.split('/')[0] : 
        url.split('/p/')[1]?.split('/')[0];
    
    if (!shortcode) {
        throw new Error('Could not extract shortcode from URL');
    }
    
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
    post.ownerUsername = urlParts[0] || '';
    
    // Method 1: Try to extract from JSON in script tags
    let foundInScript = false;
    const scripts = $('script:not([src])');
    
    scripts.each((i, script) => {
        if (foundInScript) return false;
        
        const content = $(script).html();
        if (!content) return;
        
        try {
            // Look for post data patterns
            const patterns = [
                // Pattern 1: Direct shortcode_media
                /"shortcode_media":\s*({.+?})(?=,"toast_content_on_load"|$)/,
                // Pattern 2: GraphQL data
                /"data":\s*{"shortcode_media":\s*({.+?})}(?=,"extensions")/,
                // Pattern 3: PostPage data
                /"PostPage"[^{]*"graphql":\s*{"shortcode_media":\s*({.+?})}(?=,"toast_content_on_load")/
            ];
            
            for (const pattern of patterns) {
                const match = content.match(pattern);
                if (match) {
                    try {
                        const data = JSON.parse(match[1]);
                        
                        if (data.shortcode || data.__typename === 'GraphImage' || data.__typename === 'GraphVideo') {
                            console.log('Found post data in JSON');
                            
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
                            return false; // Break the loop
                        }
                    } catch (parseError) {
                        continue;
                    }
                }
            }
        } catch (error) {
            // Continue
        }
    });
    
    // Method 2: Fallback to meta tags and DOM extraction
    if (!foundInScript || (!post.caption && !post.images.length && !post.videos.length)) {
        console.log('JSON extraction failed, trying meta tags and DOM...');
        
        // Extract caption from meta tag
        if (!post.caption) {
            const metaDesc = $('meta[property="og:description"]').attr('content');
            if (metaDesc) {
                let desc = metaDesc;
                // Clean the description
                desc = desc.replace(/^\d+[KMB]?\s*(likes?|comments?)[^"]*?"\s*-\s*[^"]*?\s*on\s*[^:]*?:\s*"?/, '');
                desc = desc.replace(/"\s*$/, '');
                if (desc.length > 20) {
                    post.caption = desc;
                }
            }
        }
        
        // Extract images from img tags
        if (post.images.length === 0) {
            $('img[src]').each((i, img) => {
                const src = $(img).attr('src');
                if (src && 
                    (src.includes('scontent') || src.includes('cdninstagram')) &&
                    !src.includes('profile') &&
                    !src.includes('s150x150')) {
                    
                    post.images.push({
                        url: src,
                        width: parseInt($(img).attr('width')) || 0,
                        height: parseInt($(img).attr('height')) || 0,
                        source: 'dom'
                    });
                }
            });
        }
        
        // Extract videos from video tags
        if (post.videos.length === 0) {
            $('video[src], video source[src]').each((i, video) => {
                const src = $(video).attr('src');
                if (src && !src.startsWith('blob:')) {
                    post.videos.push({
                        url: src,
                        width: 0,
                        height: 0,
                        source: 'dom'
                    });
                }
            });
        }
        
        // Extract engagement from page text
        const pageText = $.text();
        
        const likeMatches = pageText.match(/(\d+(?:,\d+)*)\s*likes?/i);
        if (likeMatches) {
            post.likesCount = parseInt(likeMatches[1].replace(/,/g, ''));
        }
        
        const commentMatches = pageText.match(/(\d+(?:,\d+)*)\s*comments?/i);
        if (commentMatches) {
            post.commentsCount = parseInt(commentMatches[1].replace(/,/g, ''));
        }
        
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
    
    console.log(`Post extraction result:`, {
        caption: post.caption ? `Found (${post.caption.length} chars)` : 'Not found',
        images: post.images.length,
        videos: post.videos.length,
        likes: post.likesCount,
        comments: post.commentsCount,
        views: post.viewCount
    });
    
    return post;
};

// Create proxy configuration
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// Main crawler configuration
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    requestHandlerTimeoutSecs,
    maxConcurrency,
    
    // Set headers using preNavigationHooks
    preNavigationHooks: [
        (crawlingContext) => {
            // Set realistic headers
            crawlingContext.request.headers = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
        }
    ],
    
    async requestHandler({ $, body, request, log }) {
        const url = request.url;
        log.info(`Processing: ${url}`);
        
        try {
            if (url.includes('/p/') || url.includes('/reel/')) {
                // Handle individual post or reel
                const postData = extractInstagramData(body, url);
                
                if (postData && postData.url) {
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
                const result = extractInstagramData(body, url);
                
                if (result && result.postUrls) {
                    const postUrls = result.postUrls.slice(0, maxPostsPerProfile);
                    log.info(`Found ${postUrls.length} content items for ${username}`);
                    
                    // Add content URLs to request queue
                    const requests = postUrls.map(postUrl => ({ url: postUrl }));
                    await crawler.addRequests(requests);
                } else {
                    log.warning(`No posts found for ${username}`);
                }
            }
        } catch (error) {
            log.error(`Error processing ${url}:`, error.message);
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.error(`Request ${request.url} failed ${request.retryCount + 1} times`);
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