const https = require('https');
const fs    = require('fs');
const path  = require('path');

const APP_ID   = process.env.PC_APP_ID;
const SECRET   = process.env.PC_SECRET;
const HFG_TYPE = '203011'; // Your Home Fellowship group type ID
const auth     = Buffer.from(`${APP_ID}:${SECRET}`).toString('base64');

// Privacy offset: 0.005–0.012 degrees (~500m–1.2km) in a random direction
function offsetCoord(val) {
  const magnitude = 0.005 + Math.random() * 0.007;
  const direction = Math.random() < 0.5 ? 1 : -1;
  return parseFloat((parseFloat(val) + magnitude * direction).toFixed(6));
}

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.planningcenteronline.com',
      path,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.substring(0,200))); }
      });
    }).on('error', reject);
  });
}

async function fetchAllGroups() {
  let allGroups = [];
  // Include enrollment so we get enrollment_open field
  let path = '/groups/v2/groups?per_page=100&include=enrollment';
  while (path) {
    const res = await get(path);
    allGroups = allGroups.concat(res.data);
    path = res.links && res.links.next
      ? res.links.next.replace('https://api.planningcenteronline.com', '')
      : null;
  }
  return allGroups;
}

async function fetchLocation(locationId) {
  try {
    const res = await get(`/groups/v2/locations/${locationId}`);
    return res.data && res.data.attributes ? res.data.attributes : null;
  } catch (e) {
    return null;
  }
}

// Fetch tags for a group — returns array of tag name strings
async function fetchTags(groupId) {
  try {
    const res = await get(`/groups/v2/groups/${groupId}/tags?per_page=25`);
    if (!res.data || res.data.length === 0) return [];
    return res.data
      .filter(t => t.attributes && t.attributes.name)
      .map(t => t.attributes.name.trim());
  } catch (e) {
    return [];
  }
}

// Load the manually-maintained group-leaders.json file
function loadLeaders() {
  const leadersPath = path.join(__dirname, 'group-leaders.json');
  try {
    const raw = fs.readFileSync(leadersPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('  Warning: could not load group-leaders.json -', e.message);
    return {};
  }
}

async function main() {
  console.log('Fetching groups from Planning Center...');
  const allGroups = await fetchAllGroups();
  console.log(`Total groups: ${allGroups.length}`);

  const hfgGroups = allGroups.filter(g =>
    g.attributes.listed === true &&
    g.relationships &&
    g.relationships.group_type &&
    g.relationships.group_type.data &&
    g.relationships.group_type.data.id === HFG_TYPE
  );
  console.log(`Home Fellowship Groups: ${hfgGroups.length}`);

  const leaders = loadLeaders();
  console.log(`Leader records loaded: ${Object.keys(leaders).filter(k => !k.startsWith('_')).length}`);

  const output = [];

  for (const g of hfgGroups) {
    const attr = g.attributes;
    const locationId = g.relationships.location &&
                       g.relationships.location.data &&
                       g.relationships.location.data.id;

    let lat = null, lng = null;

    if (locationId) {
      const loc = await fetchLocation(locationId);
      if (loc && loc.latitude && loc.longitude) {
        lat = offsetCoord(loc.latitude);
        lng = offsetCoord(loc.longitude);
        console.log(`  ${attr.name}: location offset applied`);
      }
    }

    if (!lat || !lng) {
      lat = offsetCoord(39.5296);
      lng = offsetCoord(-119.8138);
      console.log(`  ${attr.name}: no location, using Reno center`);
    }

    // Fetch tags (teaching style: sermon discussion, bible study, book study, etc.)
    const tags = await fetchTags(g.id);
    if (tags.length) console.log(`  ${attr.name}: tags = [${tags.join(', ')}]`);

    // Enrollment open/closed — populated when ?include=enrollment is used
    let enrollmentOpen = null;
    if (typeof attr.enrollment_open === 'boolean') {
      enrollmentOpen = attr.enrollment_open;
    }
    console.log(`  ${attr.name}: enrollment_open = ${enrollmentOpen}`);

    // Build sign-up URL
    let url = `https://groups.planningcenteronline.com/groups/${g.id}`;
    if (attr.public_church_center_web_url) url = attr.public_church_center_web_url;
    else if (attr.contact_email) url = `mailto:${attr.contact_email}`;

    // Leader from group-leaders.json only — never from PC API
    const leaderRecord = leaders[String(g.id)] || null;

    output.push({
      id:              g.id,
      name:            attr.name,
      leader_name:     leaderRecord ? leaderRecord.leader_name : '',
      initials:        leaderRecord ? leaderRecord.initials    : 'HF',
      enrollment_open: enrollmentOpen,
      tags,
      description:     attr.description_as_plain_text || '',
      schedule:        attr.schedule || '',
      photo:           attr.header_image && attr.header_image.medium ? attr.header_image.medium : '',
      url,
      lat,
      lng,
      synced_at:       new Date().toISOString()
    });
  }

  const result = { groups: output, synced_at: new Date().toISOString() };
  fs.writeFileSync('groups.json', JSON.stringify(result, null, 2));
  console.log(`\nWrote ${output.length} groups to groups.json`);
  output.forEach(g => {
    console.log(`  ${g.name}: leader="${g.leader_name}" initials="${g.initials}" open=${g.enrollment_open} tags=[${g.tags.join(', ')}]`);
  });
}

main().catch(e => { console.error('Sync failed:', e); process.exit(1); });
