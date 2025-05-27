# 📷 Instagram Post Scraper

Professional Instagram Post Scraper built for the Apify platform. Extract comprehensive data from Instagram posts including captions, hashtags, mentions, comments, engagement metrics, images, videos, and metadata.

## ✨ Features

- **🎯 Multiple Input Methods**: Scrape from usernames or direct post URLs
- **📊 Rich Data Extraction**: Captions, hashtags, mentions, engagement metrics
- **💬 Comment Scraping**: Extract comments with user information
- **🖼️ Media Support**: Images, videos, and carousel posts
- **📅 Date Filtering**: Filter posts by date range
- **⚡ High Performance**: Optimized for speed and reliability
- **🔄 Robust Error Handling**: Automatic retries and comprehensive logging
- **📈 Scalable**: Configurable concurrency and proxy support

## 🚀 Quick Start

### Basic Usage

1. **By Username**: Enter Instagram usernames to scrape their recent posts
```json
{
  "usernames": ["natgeo", "nasa"],
  "maxPostsPerProfile": 20
}
```

2. **By Post URLs**: Scrape specific posts directly
```json
{
  "postUrls": [
    "https://www.instagram.com/p/ABC123/",
    "https://www.instagram.com/p/DEF456/"
  ]
}
```

3. **Advanced Configuration**: Full control over data extraction
```json
{
  "usernames": ["travel"],
  "maxPostsPerProfile": 50,
  "includeComments": true,
  "maxCommentsPerPost": 20,
  "dateFrom": "2024-01-01",
  "dateTo": "2024-12-31"
}
```

## 📋 Input Parameters

### **Required** (at least one)
- `usernames` - Array of Instagram usernames (without @)
- `postUrls` - Array of direct Instagram post URLs

### **Content Options**
- `maxPostsPerProfile` - Maximum posts per profile (1-1000, default: 50)
- `includeComments` - Extract comments (default: false)
- `maxCommentsPerPost` - Max comments per post (1-100, default: 10)
- `includeHashtags` - Extract hashtags (default: true)
- `includeMentions` - Extract mentions (default: true)
- `includeLocation` - Extract location data (default: true)
- `includeEngagementMetrics` - Extract likes/comments count (default: true)

### **Date Filters**
- `dateFrom` - Only posts newer than date (YYYY-MM-DD)
- `dateTo` - Only posts older than date (YYYY-MM-DD)

### **Advanced Options**
- `proxyConfiguration` - Proxy settings (default: Apify proxy)
- `maxConcurrency` - Parallel requests (1-50, default: 5)
- `maxRequestRetries` - Failed request retries (0-10, default: 3)
- `requestHandlerTimeoutSecs` - Request timeout (30-300s, default: 60)

## 📤 Output Format

Each scraped post contains:

```json
{
  "url": "https://www.instagram.com/p/ABC123/",
  "shortcode": "ABC123",
  "ownerUsername": "username",
  "caption": "Post caption text...",
  "hashtags": ["#nature", "#photography"],
  "mentions": ["@friend1", "@brand"],
  "type": "image|video|carousel_album|carousel_video",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "likesCount": 1250,
  "commentsCount": 89,
  "images": [
    {
      "url": "https://...",
      "alt": "Image description"
    }
  ],
  "videos": [
    {
      "url": "https://...",
      "poster": "https://..."
    }
  ],
  "locationName": "New York, NY",
  "locationId": "12345",
  "comments": [
    {
      "text": "Great post!",
      "username": "commenter1",
      "position": 1
    }
  ],
  "scrapedAt": "2024-01-15T12:00:00.000Z"
}
```

## 🎯 Use Cases

### **Marketing & Analytics**
- Track competitor content performance
- Analyze hashtag effectiveness
- Monitor brand mentions
- Content strategy research

### **Research & Analysis**
- Social media sentiment analysis
- Trend identification
- Influencer marketing research
- Academic social media studies

### **Business Intelligence**
- Customer engagement tracking
- Market research
- Campaign performance analysis
- Social listening

## ⚡ Performance

- **Speed**: 100-200 posts per minute (depends on content complexity)
- **Reliability**: Built-in retry mechanisms and error handling
- **Scalability**: Configurable concurrency for optimal performance
- **Cost**: Pay-per-result pricing model

## 🔒 Ethics & Compliance