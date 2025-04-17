const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const nlp = require('compromise');
const admin = require('firebase-admin');

// Initialize Firebase Admin if credentials are available
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString())
      )
    });
    firebaseInitialized = true;
  }
} catch (error) {
  console.error('Firebase initialization failed:', error);
}

// Add the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Browser instance to be reused (for Vercel serverless efficiency)
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });
  }
  return browserPromise;
}

// Extract names from text using Compromise NLP
function extractNames(text) {
  if (!text) return [];
  
  const doc = nlp(text);
  const people = doc.people().out('array');
  
  // If no names found, try to extract capitalized phrases
  if (people.length === 0) {
    const nouns = doc.match('#ProperNoun+').out('array');
    return nouns.filter(noun => 
      noun.length > 1 && 
      !['Google', 'Instagram', 'LinkedIn', 'Twitter', 'Facebook'].includes(noun)
    );
  }
  
  return people;
}

// Perform Google Image Search
async function searchGoogleImages(browser, imageBase64) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://images.google.com/', { waitUntil: 'networkidle2' });
    
    // Click on the camera icon to search by image
    await page.waitForSelector('[aria-label="Search by image"]');
    await page.click('[aria-label="Search by image"]');
    
    // Wait for the upload option
    await page.waitForSelector('a[aria-label="Upload an image"]');
    await page.click('a[aria-label="Upload an image"]');
    
    // Wait for file input and upload the image
    const inputElement = await page.waitForSelector('input[type="file"]');
    
    // Convert base64 to file
    const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
    
    // Upload the image
    await inputElement.uploadFile({
      name: 'image.jpg',
      content: imageBuffer,
      type: 'image/jpeg'
    });
    
    // Wait for search results
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
    
    // Extract search results
    const results = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.g'));
      return items.map(item => {
        const titleEl = item.querySelector('h3');
        const linkEl = item.querySelector('a');
        const descEl = item.querySelector('.VwiC3b');
        
        return {
          title: titleEl ? titleEl.innerText : '',
          link: linkEl ? linkEl.href : '',
          description: descEl ? descEl.innerText : ''
        };
      }).filter(item => item.title && item.link);
    });
    
    // Extract possible names from results
    const allText = results.map(r => `${r.title} ${r.description}`).join(' ');
    const possibleNames = extractNames(allText);
    
    return {
      searchResults: results,
      possibleNames
    };
  } catch (error) {
    console.error('Error during Google Image Search:', error);
    return { searchResults: [], possibleNames: [] };
  } finally {
    await page.close();
  }
}

// Search for social media profiles
async function searchSocialMedia(browser, name) {
  const profiles = {
    name,
    instagram: null,
    linkedin: null,
    twitter: null
  };
  
  // Search Instagram
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`https://www.instagram.com/explore/search/`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });
    
    // Type the search query
    await page.waitForSelector('input[placeholder="Search"]');
    await page.type('input[placeholder="Search"]', name);
    
    // Wait for search results
    await page.waitForSelector('a[href^="/"]', { timeout: 5000 });
    
    // Get the first profile link
    const instagramHandles = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/"]'))
        .filter(link => !link.href.includes('/explore/') && !link.href.includes('/search/'));
      return links.slice(0, 3).map(link => link.href);
    });
    
    if (instagramHandles.length > 0) {
      profiles.instagram = instagramHandles[0];
    }
    
    await page.close();
  } catch (error) {
    console.error('Error searching Instagram:', error);
  }
  
  // Search LinkedIn
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });
    
    // Get the first profile link
    const linkedinProfiles = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
      return links.slice(0, 3).map(link => link.href);
    });
    
    if (linkedinProfiles.length > 0) {
      profiles.linkedin = linkedinProfiles[0];
    }
    
    await page.close();
  } catch (error) {
    console.error('Error searching LinkedIn:', error);
  }
  
  // Search Twitter/X
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`https://x.com/search?q=${encodeURIComponent(name)}&f=user`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });
    
    // Get the first profile link
    const twitterProfiles = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/status/"]'))
        .map(link => {
          const href = link.href;
          const username = href.split('/status/')[0].split('x.com/')[1];
          return `https://x.com/${username}`;
        });
      return [...new Set(links)].slice(0, 3);
    });
    
    if (twitterProfiles.length > 0) {
      profiles.twitter = twitterProfiles[0];
    }
    
    await page.close();
  } catch (error) {
    console.error('Error searching Twitter/X:', error);
  }
  
  return profiles;
}

// Store search history in Firebase (if initialized)
async function storeSearchHistory(userId, results) {
  if (!firebaseInitialized) return;
  
  try {
    const db = admin.firestore();
    await db.collection('searches').add({
      userId: userId || 'anonymous',
      results,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error storing search history:', error);
  }
}

// Main handler function
async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get the image from the request body
    const { image, userId } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // Get the browser instance
    const browser = await getBrowser();
    
    // Perform Google Image Search
    console.log('Performing Google Image Search...');
    const { searchResults, possibleNames } = await searchGoogleImages(browser, image);
    
    // If no names found, return an error
    if (possibleNames.length === 0) {
      return res.status(200).json({
        success: true,
        profiles: []
      });
    }
    
    // Use the first name found for social media search
    const name = possibleNames[0];
    console.log(`Searching social media for: ${name}`);
    
    // Search for social media profiles
    const profiles = await searchSocialMedia(browser, name);
    
    // Store search history if Firebase is initialized
    storeSearchHistory(userId, { name, profiles });
    
    // Return the results
    return res.status(200).json({
      success: true,
      profiles: [profiles]
    });
  } catch (error) {
    console.error('Error in search-image API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Export handler function for Vercel serverless deployment
module.exports = handler; 