---
name: morning-brief
description: "Daily morning briefing with weather, market movers, and news headlines"
category: productivity
version: 1.0.0
license: Apache-2.0
origin: community
tags: productivity, news, weather, finance, stocks, daily-brief
---

# Morning Brief

Start your day with a concise briefing covering current weather, top stock market movers, and latest news headlines.

## When to Use

- User says "give me my morning brief"
- User says "what's happening today"
- User asks for a daily summary of weather, markets, and news
- User wants a quick overview before starting their work day

## How to Use

### 1. Fetch Current Weather

Use `web_search` to get current weather for the user's location:

```
Query: "current weather [location]"
```

### 2. Get Top NSE Market Movers

Use `get_stocks` tool to fetch top gainers and losers:

```
get_stocks --index NSE --top 5 --type gainers
get_stocks --index NSE --top 5 --type losers
```

### 3. Fetch Top 5 News Headlines

Use `web_search` for latest news:

```
Query: "top news headlines today"
```

### 4. Format and Present

Combine all information into a clean, readable summary:

```
🌤️ Weather
[Current conditions]

📈 Market Movers (NSE)
Top Gainers:
- [Stock]: +[X]%
- [Stock]: +[X]%

Top Losers:
- [Stock]: -[X]%
- [Stock]: -[X]%

📰 Top Headlines
1. [Headline 1]
2. [Headline 2]
3. [Headline 3]
4. [Headline 4]
5. [Headline 5]

Brief generated at [timestamp]
```

## Examples

**"Give me my morning brief"**
→ Fetches weather, NSE top 5 gainers/losers, and top 5 news headlines. Presents as formatted summary.

**"What's happening today?"**
→ Same as above — comprehensive morning briefing.

## Notes

- Weather location defaults to user's detected location or can be specified
- Market data uses NSE (National Stock Exchange) by default
- News headlines are fetched from general sources
- Use `notify` tool to send the briefing if user is not actively chatting
