// main.js - Instagram Post Scraper (instagrapi + Direct API approach)
import { Actor } from 'apify';
import { Dataset } from 'crawlee';

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
    dateFrom,
    dateTo
} = input;

// Initialize dataset for storing results
const dataset = await Dataset.open();

// Create HTTP client with Instagram mobile app headers
const createInstagramClient = () => {
    const headers = {
        'User-Agent': 'Instagram 276.0.0.18.119 Android (33/13; 420dpi; 1080x2400; samsung; SM-G981B; y2s; exynos990; en_US; 458229237)',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-IG-App-ID': '936619743392459',
        'X-IG-App-Locale': 'en_US',
        'X-IG-Device-Locale': 'en_US',
        'X-IG-Mapped-Locale': 'en_US',
        'X-Pigeon-Session-Id': generateSessionId(),
        'X-Pigeon-Rawclienttime': Math.floor(Date.now() / 1000).toString(),
        'X-IG-Connection-Speed': Math.floor(Math.random() * 3000 + 1000) + 'kbps',
        'X-IG-Bandwidth-Speed-Kbps': Math.floor(Math.random() * 3000 + 1000).toString(),
        'X-IG-Bandwidth-TotalBytes-B': Math.floor(Math.random() * 50000000 + 10000000).toString(),
        'X-IG-Bandwidth-TotalTime-MS': Math.floor(Math.random() * 5000 + 1000).toString(),
        'X-Bloks-Version-Id': '5f56efad68e1edec7801f630b5c122704ec5378adbee6609a448f105f34a9c73',
        'X-IG-WWW-Claim': '0',
        'X-Bloks-Is-Layout-RTL': 'false',
        'X-Bloks-Is-Panorama-Enabled': 'true',
        'X-IG-Device-ID': generateDeviceId(),
        'X-IG-Family-Device-ID': generateDeviceId(),
        'X-IG-Android-ID': generateAndroidId(),
        'X-IG-Timezone-Offset': '0',
        'X-IG-Connection-Type': 'WIFI',
        'X-IG-Capabilities': '3brTvwM=',
        'X-IG-App-Startup-Country': 'US',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Host': 'i.instagram.com',
        'X-FB-HTTP-Engine': 'Liger',
        'Connection': 'keep-alive'
    };

    return { headers };
};

// Helper functions to generate realistic IDs
function generateSessionId() {
    return 'UFS-' + Array.from({length: 8}, () => Math.random().toString(36)[2]).join('') + '-0';
}

function generateDeviceId() {
    return 'android-' + Array.from({length: 16}, () => Math.random().toString(16)[2]).join('');
}

function generateAndroidId() {
    return Array.from({length: 16}, () => Math.random().toString(16)[2]).join('');
}

// Function to extract user info using Instagram's web profile API
const getUserInfo = async (username) => {
    try {
        console.log(`Getting user info for: ${username}`);
        
        const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': 'missing',
                'X-IG-App-ID': '936619743392459',
                'X-IG-WWW-Claim': '0',
                'X-Instagram-AJAX': '1007616134',
                'Referer': `https://www.instagram.com/${username}/`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        
        if (data.data && data.data.user) {
            const user = data.data.user;
            console.log(`Successfully got user info for ${username}: ${user.edge_owner_to_timeline_media?.count || 0} posts`);
            return user;
        } else {
            throw new Error('Invalid response structure');
        }
    } catch (error) {
        console.log(`Error getting user info for ${username}:`, error.message);
        return null;
    }
};

// Function to get post info by shortcode
const getPostInfo = async (shortcode) => {
    try {
        console.log(`Getting post info for shortcode: ${shortcode}`);
        
        // Try the GraphQL endpoint first
        const graphqlUrl = 'https://www.instagram.com/graphql/query/';
        const queryHash = '2b0673e0dc4580674a88d426fe00ea90'; // This hash is for post info queries
        
        const response = await fetch(`${graphqlUrl}?query_hash=${queryHash}&variables=${encodeURIComponent(JSON.stringify({
            shortcode: shortcode,
            child_comment_count: includeComments ? maxCommentsPerPost : 0,
            fetch_comment_count: includeComments ? maxCommentsPerPost : 0,
            parent_comment_count: includeComments ? maxCommentsPerPost : 0,
            has_threaded_comments: true
        }))}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': 'missing',
                'X-IG-App-ID': '936619743392459',
                'X-IG-WWW-Claim': '0',
                'X-Instagram-AJAX': '1007616134',
                'Referer': `https://www.instagram.com/p/${shortcode}/`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.data && data.data.shortcode_media) {
                console.log(`Successfully got post info for ${shortcode}`);
                return data.data.shortcode_media;
            }
        }

        // Fallback: Try to get post info from the post page
        console.log(`GraphQL failed, trying fallback method for ${shortcode}`);
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;
        
        const pageResponse = await fetch(postUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            }
        });

        if (pageResponse.ok) {
            const html = await pageResponse.text();
            
            // Extract JSON data from the HTML
            const scriptMatch = html.match(/window\._sharedData\s*=\s*({.+?});/);
            if (scriptMatch) {
                const sharedData = JSON.parse(scriptMatch[1]);
                const postData = sharedData.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
                if (postData) {
                    console.log(`Successfully extracted post data from HTML for ${shortcode}`);
                    return postData;
                }
            }

            // Alternative: Look for other JSON patterns
            const additionalMatch = html.match(/"shortcode_media":\s*({.+?})(?=,"toast_content_on_load")/);
            if (additionalMatch) {
                const postData = JSON.parse(additionalMatch[1]);
                console.log(`Successfully extracted post data from alternative pattern for ${shortcode}`);
                return postData;
            }
        }

        throw new Error('All methods failed to get post data');
        
    } catch (error) {
        console.log(`Error getting post info for ${shortcode}:`, error.message);
        return null;
    }
};

// Function to process Instagram post data
const processPostData = (postData, isReel = false) => {
    if (!postData) return null;

    const post = {
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${postData.shortcode}/`,
        shortcode: postData.shortcode,
        isReel: isReel,
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

    // Extract basic info
    post.ownerUsername = postData.owner?.username || '';
    post.likesCount = postData.edge_media_preview_like?.count || 0;
    post.commentsCount = postData.edge_media_to_parent_comment?.count || 0;
    post.viewCount = postData.video_view_count || 0;

    // Extract timestamp
    if (postData.taken_at_timestamp) {
        post.timestamp = new Date(postData.taken_at_timestamp * 1000).toISOString();
    }

    // Extract caption
    if (postData.edge_media_to_caption?.edges?.length > 0) {
        post.caption = postData.edge_media_to_caption.edges[0].node.text || '';
        
        // Extract hashtags and mentions
        if (post.caption) {
            post.hashtags = [...new Set((post.caption.match(/#[a-zA-Z0-9_]+/g) || []).map(h => h.toLowerCase()))];
            post.mentions = [...new Set((post.caption.match(/@[a-zA-Z0-9_.]+/g) || []).map(m => m.toLowerCase()))];
        }
    }

    // Extract location
    if (postData.location) {
        post.locationName = postData.location.name || '';
        post.locationId = postData.location.id || '';
    }

    // Extract media URLs
    if (postData.display_url) {
        post.images.push({
            url: postData.display_url,
            width: postData.dimensions?.width || 0,
            height: postData.dimensions?.height || 0,
            source: 'api'
        });
    }

    if (postData.video_url) {
        post.videos.push({
            url: postData.video_url,
            width: postData.dimensions?.width || 0,
            height: postData.dimensions?.height || 0,
            source: 'api'
        });
    }

    // Handle carousel posts
    if (postData.edge_sidecar_to_children?.edges) {
        post.images = []; // Clear single image if carousel
        post.videos = []; // Clear single video if carousel
        
        for (const edge of postData.edge_sidecar_to_children.edges) {
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

    // Extract comments if requested
    if (includeComments && postData.edge_media_to_parent_comment?.edges) {
        post.comments = postData.edge_media_to_parent_comment.edges
            .slice(0, maxCommentsPerPost)
            .map((edge, index) => ({
                text: edge.node.text || '',
                username: edge.node.owner?.username || '',
                position: index + 1,
                created_at: edge.node.created_at ? new Date(edge.node.created_at * 1000).toISOString() : ''
            }));
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
};

// Function to get posts from a user profile
const getProfilePosts = async (username, maxPosts) => {
    try {
        const userInfo = await getUserInfo(username);
        if (!userInfo) {
            console.log(`Could not get user info for ${username}`);
            return [];
        }

        const posts = [];
        const mediaEdges = userInfo.edge_owner_to_timeline_media?.edges || [];
        
        console.log(`Found ${mediaEdges.length} posts for ${username}`);
        
        for (let i = 0; i < Math.min(mediaEdges.length, maxPosts); i++) {
            const edge = mediaEdges[i];
            const shortcode = edge.node.shortcode;
            
            // Determine if this is a reel
            const isReel = edge.node.__typename === 'GraphVideo' || edge.node.product_type === 'clips';
            
            console.log(`Processing ${isReel ? 'reel' : 'post'} ${i + 1}/${Math.min(mediaEdges.length, maxPosts)}: ${shortcode}`);
            
            // Get detailed post info
            const postData = await getPostInfo(shortcode);
            if (postData) {
                const processedPost = processPostData(postData, isReel);
                if (processedPost) {
                    // Apply date filters
                    if (dateFrom || dateTo) {
                        const postDate = new Date(processedPost.timestamp);
                        if (dateFrom && postDate < new Date(dateFrom)) continue;
                        if (dateTo && postDate > new Date(dateTo)) continue;
                    }
                    
                    posts.push(processedPost);
                }
            }
            
            // Add delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        }
        
        return posts;
    } catch (error) {
        console.log(`Error getting posts for ${username}:`, error.message);
        return [];
    }
};

// Function to get individual post by URL
const getPostByUrl = async (postUrl) => {
    try {
        const shortcode = postUrl.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1];
        if (!shortcode) {
            throw new Error('Invalid post URL format');
        }
        
        const isReel = postUrl.includes('/reel/');
        
        console.log(`Getting ${isReel ? 'reel' : 'post'} data for: ${shortcode}`);
        
        const postData = await getPostInfo(shortcode);
        if (postData) {
            return processPostData(postData, isReel);
        }
        
        return null;
    } catch (error) {
        console.log(`Error getting post from URL ${postUrl}:`, error.message);
        return null;
    }
};

// Main execution
async function main() {
    try {
        const allPosts = [];
        
        // Process usernames
        for (const username of usernames) {
            if (username.trim()) {
                console.log(`\n=== Processing profile: ${username} ===`);
                const posts = await getProfilePosts(username.trim(), maxPostsPerProfile);
                allPosts.push(...posts);
                
                // Add delay between profiles
                if (usernames.indexOf(username) < usernames.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
        
        // Process individual post URLs
        for (const postUrl of postUrls) {
            if (postUrl.trim()) {
                console.log(`\n=== Processing post URL: ${postUrl} ===`);
                const post = await getPostByUrl(postUrl.trim());
                if (post) {
                    allPosts.push(post);
                }
                
                // Add delay between posts
                if (postUrls.indexOf(postUrl) < postUrls.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        
        // Filter data based on user preferences and save results
        for (const post of allPosts) {
            if (!includeHashtags) delete post.hashtags;
            if (!includeMentions) delete post.mentions;
            if (!includeLocation) {
                delete post.locationName;
                delete post.locationId;
            }
            if (!includeEngagementMetrics) {
                delete post.likesCount;
                delete post.commentsCount;
                delete post.viewCount;
            }
            if (!includeComments) {
                delete post.comments;
            }
            
            post.scrapedAt = new Date().toISOString();
            
            await dataset.pushData(post);
        }
        
        console.log(`\n=== Scraping completed ===`);
        console.log(`Total posts scraped: ${allPosts.length}`);
        
        // Log summary
        const imageCount = allPosts.reduce((sum, post) => sum + post.images.length, 0);
        const videoCount = allPosts.reduce((sum, post) => sum + post.videos.length, 0);
        const reelCount = allPosts.filter(post => post.isReel).length;
        
        console.log(`- Images extracted: ${imageCount}`);
        console.log(`- Videos extracted: ${videoCount}`);
        console.log(`- Reels: ${reelCount}`);
        console.log(`- Regular posts: ${allPosts.length - reelCount}`);
        
    } catch (error) {
        console.error('Main execution error:', error);
        throw error;
    }
}

// Run the scraper
await main();
await Actor.exit();