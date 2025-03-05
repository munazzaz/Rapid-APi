import { ApifyClient } from 'apify-client';

// In-memory cache keyed solely on the query.
// This will store the full dataset (e.g. up to 35 profiles) for each query.
const fullSearchCache = {};

// Maximum pages we allow (and therefore how many items to fetch = maxPages * limit)
const MAX_PAGES = 7;

export default async function handler(req, res) {
  // Allow only GET requests.
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed. Only GET is supported.' });
  }

  try {
    const { query, platform, page = 1, limit = 5 } = req.query;

    // Validate query and platform.
    if (!query || query === '*') {
      return res.status(400).json({ error: 'Invalid query parameter. Provide a search term.' });
    }
    if (platform && platform.toLowerCase() !== 'instagram') {
      return res.status(400).json({ error: 'Please select the correct platform. Only Instagram is supported.' });
    }

    // Parse page and limit.
    const pageInt = parseInt(page, 10);
    const limitInt = parseInt(limit, 10);
    if (isNaN(pageInt) || pageInt < 1) {
      return res.status(400).json({ error: 'Invalid "page" parameter. Must be a positive integer.' });
    }
    if (isNaN(limitInt) || limitInt < 1) {
      return res.status(400).json({ error: 'Invalid "limit" parameter. Must be a positive integer.' });
    }
    if (pageInt > MAX_PAGES) {
      return res.status(400).json({ error: `Page ${pageInt} exceeds the maximum of ${MAX_PAGES} pages.` });
    }

    // Use a cache key based solely on the query (so all pages share the same dataset)
    const cacheKey = query.toLowerCase();

    let fullData;
    // Check if we already have the full data for this query cached.
    if (fullSearchCache[cacheKey]) {
      fullData = fullSearchCache[cacheKey];
    } else {
      // Not cached: fetch full data with a larger searchLimit.
      const totalFetchLimit = MAX_PAGES * limitInt; // e.g. 35 items if limit is 5
      const client = new ApifyClient({
        token: 'apify_api_Fg3EwbIxRvoUMvKQp2YORhaoypUoc007jmoa',
      });

      const input = {
        search: query,
        searchType: 'user',
        searchLimit: totalFetchLimit,
        offset: 0, // fetch from the start
      };

      // Call the Apify actor (this may take several seconds).
      const run = await client.actor('apify/instagram-search-scraper').call(input);
      if (!run || !run.defaultDatasetId) {
        return res.status(502).json({
          error: 'Apify actor did not return a valid dataset. Possibly a scraping failure.',
        });
      }
      const datasetClient = client.dataset(run.defaultDatasetId);
      const { items } = await datasetClient.listItems({ limit: totalFetchLimit, offset: 0 });
      if (!items || !items.length) {
        return res.status(404).json({ error: 'No related profiles found.' });
      }
      fullData = items;
      // Cache the full dataset for this query.
      fullSearchCache[cacheKey] = fullData;
    }

    // Reorder the full data so that, if an exact match exists, it is placed at the beginning.
    const q = query.toLowerCase();
    let orderedData;
    // Find an exact match (or matches) from the full data.
    const exactMatchIndex = fullData.findIndex(item => (item.username || '').toLowerCase() === q);
    if (exactMatchIndex !== -1) {
      // If found, remove all exact matches from the rest of the data.
      const exactMatches = fullData.filter(item => (item.username || '').toLowerCase() === q);
      const remainingProfiles = fullData.filter(item => (item.username || '').toLowerCase() !== q);

      // Sort the remaining profiles by whether the username starts with the query and by length.
      remainingProfiles.sort((a, b) => {
        const aUser = (a.username || '').toLowerCase();
        const bUser = (b.username || '').toLowerCase();
        const aStarts = aUser.startsWith(q);
        const bStarts = bUser.startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return aUser.length - bUser.length;
      });
      // Place the first exact match at the top.
      orderedData = [exactMatches[0], ...remainingProfiles];
    } else {
      // No exact match; simply sort the full data.
      orderedData = [...fullData];
      orderedData.sort((a, b) => {
        const aUser = (a.username || '').toLowerCase();
        const bUser = (b.username || '').toLowerCase();
        const aStarts = aUser.startsWith(q);
        const bStarts = bUser.startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return aUser.length - bUser.length;
      });
    }

    // Apply pagination on the reordered data.
    const startIndex = (pageInt - 1) * limitInt;
    const endIndex = startIndex + limitInt;
    const paginatedItems = orderedData.slice(startIndex, endIndex);
    if (!paginatedItems.length) {
      return res.status(404).json({
        error: `No related profiles found for page ${pageInt}.`
      });
    }

    // Map the items to the desired response shape.
    const profiles = paginatedItems.map(item => ({
      id: item.id || item.username,
      username: item.username,
      bio: item.bio || '',
      profilePicture: item.profilePicUrlHD || item.profilePicUrl || '/no-profile-pic-img.png',
    }));

    // Create the response data. We use the full dataset's length for total,
    // and assume total pages = MAX_PAGES.
    const responseData = {
      profiles,
      total: fullData.length,
      currentPage: pageInt,
      totalPages: MAX_PAGES,
    };

    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Error fetching Instagram profiles:', error);
    if (error.message?.includes('TIMEOUT')) {
      return res.status(504).json({ error: 'Scraper timed out. Please try again later.' });
    }
    if (error.message?.includes('invalid token')) {
      return res.status(401).json({ error: 'Invalid Apify token.' });
    }
    return res.status(500).json({ error: 'Internal Server Error. ' + (error.message || 'Unknown error') });
  }
}

