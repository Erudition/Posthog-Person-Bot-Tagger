const axios = require('axios');

// Base paths

const singleIPs = new Map();
const sortedRanges = [];

function ipToLong(ip) {
    if (!ip || typeof ip !== 'string') return 0;
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return (
        (parseInt(parts[0], 10) * 16777216) +
        (parseInt(parts[1], 10) * 65536) +
        (parseInt(parts[2], 10) * 256) +
        (parseInt(parts[3], 10))
    ) >>> 0;
}

function addEntry(range, type, name, category, rating, source) {
    if (!range) return;
    const cleanRange = range.trim();

    const newData = {
        range: cleanRange,
        type,
        name: name || 'Unknown',
        category: category || 'Uncategorized',
        rating: rating || 'neutral',
        source
    };

    const merge = (existing, incoming) => {
        if (!existing) return incoming;

        // Priority logic for names:
        // 1. If existing has a specific name and incoming doesn't, keep existing.
        // 2. If incoming has a specific name and existing doesn't (Unknown/DC), take incoming.
        // 3. If incoming is 'bot' and existing is 'datacenter', keep both (merged fields).

        const isGeneric = (n) => !n || n === 'Unknown' || n === 'Uncategorized';
        const isDC = (t) => t === 'datacenter';

        let merged = { ...existing };

        // If we find a bot name and existing was just a DC or Unknown, upgrade it.
        if (incoming.type === 'bot' && !isGeneric(incoming.name)) {
            if (isDC(merged.type) || isGeneric(merged.name)) {
                merged.name = incoming.name;
                merged.type = 'bot';
                merged.category = incoming.category;
                merged.rating = incoming.rating;
                merged.source = `${merged.source} + ${incoming.source}`;
            }
        }

        // If incoming is a DC and existing is a bot, just preserve the DC info if we add a dc field later,
        // but for now let's just ensure we don't lose the bot identity.
        if (incoming.type === 'datacenter' && merged.type === 'bot') {
            merged.datacenter = incoming.name;
            merged.source = `${merged.source} (DC: ${incoming.source})`;
        } else if (incoming.type === 'datacenter' && merged.type === 'datacenter') {
            if (isGeneric(merged.name) && !isGeneric(incoming.name)) {
                merged.name = incoming.name;
            }
        }

        return merged;
    };

    if (cleanRange.includes('/')) {
        const [ip, mask] = cleanRange.split('/');
        const bitmask = parseInt(mask, 10);
        if (isNaN(bitmask)) return;
        const start = (ipToLong(ip) & (0xFFFFFFFF << (32 - bitmask))) >>> 0;
        const end = (start + (Math.pow(2, 32 - bitmask) - 1)) >>> 0;

        // Check if range already exists (simplified check for exact range match)
        const existingIdx = sortedRanges.findIndex(r => r.start === start && r.end === end);
        if (existingIdx !== -1) {
            sortedRanges[existingIdx].data = merge(sortedRanges[existingIdx].data, newData);
        } else {
            sortedRanges.push({ start, end, data: newData });
        }
    } else {
        const existing = singleIPs.get(cleanRange);
        singleIPs.set(cleanRange, merge(existing, newData));
    }
}

function findInRange(ip) {
    const target = ipToLong(ip);
    if (!target) return null;

    let low = 0;
    let high = sortedRanges.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const range = sortedRanges[mid];

        if (target >= range.start && target <= range.end) {
            return range.data;
        }

        if (target < range.start) {
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return null;
}

// --- Remote Loaders ---

async function fetchWithTimeout(url, options = {}) {
    try {
        const response = await axios.get(url, { timeout: 15000, ...options });
        if (response && typeof response.data === 'string' && (url.endsWith('.json') || response.data.trim().startsWith('['))) {
            try {
                response.data = JSON.parse(response.data);
            } catch (e) {
                // Not JSON after all
            }
        }
        return response;
    } catch (e) {
        console.warn(`Failed to fetch ${url}: ${e.message}`);
        return null;
    }
}

async function loadHexydec() {
    console.log("Fetching Hexydec lists...");
    const crawlersUrl = 'https://raw.githubusercontent.com/hexydec/ip-ranges/main/output/crawlers.json';
    const datacentresUrl = 'https://raw.githubusercontent.com/hexydec/ip-ranges/main/output/datacentres.json';

    const [cResponse, dResponse] = await Promise.all([
        fetchWithTimeout(crawlersUrl),
        fetchWithTimeout(datacentresUrl)
    ]);

    let cCount = 0;
    let dCount = 0;

    if (cResponse && Array.isArray(cResponse.data)) {
        cResponse.data.forEach(item => {
            if (item.range) {
                addEntry(item.range, 'bot', item.name, 'Crawler', 'good', 'Hexydec-Crawlers');
                cCount++;
            }
        });
    }
    if (dResponse && Array.isArray(dResponse.data)) {
        dResponse.data.forEach(item => {
            if (item.range) {
                addEntry(item.range, 'datacenter', item.name, 'Datacenter', 'neutral', 'Hexydec-Datacenters');
                dCount++;
            }
        });
    }
    console.log(`Loaded Hexydec: ${cCount} crawlers, ${dCount} datacenters`);
}

async function loadGoodBots() {
    console.log("Fetching GoodBots lists...");
    const treeUrl = 'https://api.github.com/repos/AnTheMaker/GoodBots/git/trees/main?recursive=1';
    const response = await fetchWithTimeout(treeUrl);
    if (!response) return;

    const files = response.data.tree.filter(item => item.path.startsWith('iplists/') && item.path.endsWith('.ips'));

    // Process in small batches
    const BATCH_SIZE = 5;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
            const rawUrl = `https://raw.githubusercontent.com/AnTheMaker/GoodBots/main/${file.path}`;
            const botName = file.path.split('/').pop().replace('.ips', '');
            const contentResponse = await fetchWithTimeout(rawUrl);
            if (contentResponse && typeof contentResponse.data === 'string') {
                contentResponse.data.split('\n').forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        addEntry(trimmed, 'bot', botName, 'Crawler', 'good', 'GoodBots');
                    }
                });
            }
        }));
    }
}

async function loadAvastel() {
    console.log("Fetching Avastel proxy list...");
    const url = 'https://raw.githubusercontent.com/antoinevastel/avastel-bot-ips-lists/refs/heads/master/avastel-proxy-bot-ips-blocklist-8days.txt';
    const response = await fetchWithTimeout(url);
    if (response && typeof response.data === 'string') {
        let count = 0;
        response.data.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const parts = trimmed.split(';');
            if (parts.length >= 3) {
                const [ip, as, confidence] = parts;
                if (confidence === '1.0' || confidence === '1') {
                    addEntry(ip, 'bot', `Residential Proxy (${as})`, 'ResProxy', 'bad', 'Avastel');
                    count++;
                }
            }
        });
        console.log(`Loaded ${count} high-confidence proxies from Avastel`);
    }
}

async function loadFirehol() {
    console.log("Fetching Firehol Level 1 list...");
    const url = 'https://raw.githubusercontent.com/ktsaou/blocklist-ipsets/master/firehol_level1.netset';
    const response = await fetchWithTimeout(url);
    if (response && typeof response.data === 'string') {
        response.data.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                addEntry(trimmed, 'bot', 'Firehol Blocklist', 'Malicious', 'bad', 'Firehol');
            }
        });
    }
}

async function loadShadowWhisperer() {
    console.log("Fetching ShadowWhisperer lists...");
    const treeUrl = 'https://api.github.com/repos/ShadowWhisperer/IPs/git/trees/master?recursive=1';
    const response = await fetchWithTimeout(treeUrl);
    if (!response) return;

    const categories = ['BruteForce', 'Malware', 'Other'];
    const files = response.data.tree.filter(item =>
        item.type === 'blob' &&
        categories.some(cat => item.path.startsWith(`${cat}/`)) &&
        !item.path.endsWith('.md') &&
        !item.path.endsWith('.json') &&
        !item.path.includes('LICENSE')
    );

    const BATCH_SIZE = 5;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
            const rawUrl = `https://raw.githubusercontent.com/ShadowWhisperer/IPs/master/${file.path}`;
            const category = file.path.split('/')[0];
            const name = file.path.split('/').pop();
            const contentResponse = await fetchWithTimeout(rawUrl);
            if (contentResponse && typeof contentResponse.data === 'string') {
                contentResponse.data.split('\n').forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return;
                    let ip = trimmed;
                    let comment = '';
                    if (trimmed.includes('#')) {
                        const parts = trimmed.split('#');
                        ip = parts[0].trim();
                        comment = parts[1].trim();
                    }
                    if (ip) addEntry(ip, 'bot', comment || name, category, 'bad', 'ShadowWhisperer');
                });
            }
        }));
    }
}

async function loadOfficialBotRanges() {
    console.log("Fetching Official Bot IP ranges...");
    const sources = [
        { id: 'Googlebot', url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json', category: 'Search Engine' },
        { id: 'Bingbot', url: 'https://www.bing.com/toolbox/bingbot.json', category: 'Search Engine' },
        { id: 'GPTBot', url: 'https://openai.com/gptbot.json', category: 'AI Training' },
        { id: 'ChatGPT-User', url: 'https://openai.com/chatgpt-user.json', category: 'AI User' },
        { id: 'PerplexityBot', url: 'https://www.perplexity.ai/perplexitybot.json', category: 'AI Training' }
    ];

    await Promise.all(sources.map(async (src) => {
        const response = await fetchWithTimeout(src.url);
        if (response && response.data) {
            const traverse = (obj) => {
                if (typeof obj !== 'object' || obj === null) return;
                if (obj.ipv4Prefix) addEntry(obj.ipv4Prefix, 'bot', src.id, src.category, 'good', 'Official-Source');
                Object.values(obj).forEach(val => traverse(val));
            };
            traverse(response.data);
        }
    }));

    const anthropicResponse = await fetchWithTimeout('https://platform.claude.com/docs/en/api/ip-addresses');
    if (anthropicResponse && typeof anthropicResponse.data === 'string') {
        const cidrs = anthropicResponse.data.match(/([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}/g);
        if (cidrs) cidrs.forEach(cidr => addEntry(cidr, 'bot', 'ClaudeBot', 'AI Training', 'good', 'Anthropic'));
    }
}

async function loadPostHogBotIPs() {
    const ipsUrl = 'https://raw.githubusercontent.com/PostHog/posthog/refs/heads/master/nodejs/assets/bot-ips.txt';
    console.log("Fetching PostHog Bot IPs...");

    const response = await fetchWithTimeout(ipsUrl);
    if (response && typeof response.data === 'string') {
        let count = 0;
        const lines = response.data.split('\n');
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                addEntry(trimmed, 'bot', null, 'Crawler', 'good', 'PostHog-Bot-List');
                count++;
            }
        });
        console.log(`Loaded ${count} IPs from PostHog-Bot-List`);
    } else {
        console.warn("Failed to load PostHog Bot IPs from GitHub.");
    }
}

async function loadAllBotData() {
    console.log("Loading bot data from live sources...");

    await Promise.all([
        loadHexydec(),
        loadGoodBots(),
        loadAvastel(),
        loadFirehol(),
        loadShadowWhisperer(),
        loadOfficialBotRanges(),
        loadPostHogBotIPs()
    ]);

    // Finalize ranges: sort by start address for binary search
    sortedRanges.sort((a, b) => a.start - b.start);

    console.log(`Total loaded: ${singleIPs.size} single IPs, ${sortedRanges.length} CIDR ranges.`);
    return { singleIPs, findInRange };
}

module.exports = { loadAllBotData };
