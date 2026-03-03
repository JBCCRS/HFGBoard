const https = require('https');
const fs    = require('fs');

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
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function fetchAllGroups() {
  let allGroups = [];
  let path = '/groups/v2/groups?per_page=100';
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

// Fetch the leader(s) of a group via the memberships endpoint
async function fetchLeader(groupId) {
  try {
    const res = await get(`/groups/v2/groups/${groupId}/memberships?filter=leader&per_page=5`);
    if (!res.data || res.data.length === 0) return '';
    const leaders = res.data
      .filter(m => m.attributes && m.attributes.first_name)
      .map(m => `${m.attributes.first_name} ${m.attributes.last_name || ''}`.trim());
    return leaders.join(' & ');
  } catch (e) {
    return '';
  }
}

// Extract leader surname(s) from group name as fallback
// e.g. "Home Fellowship Baker & Stewart" -> "Baker & Stewart"
function extractLeaderFromName(groupName) {
  return groupName.replace(/^Home Fellowship[-\s]*/i, '').trim();
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

  const output = [];

  for (const g of hfgGroups) {
    const attr = g.attributes;
    const locationId = g.relationships.location &&
                       g.relationships.location.data &&
                       g.relationships.location.data.id;

    let lat = null;
    let lng = null;

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

    // Try memberships endpoint first, fall back to extracting from group name
    let leader = await fetchLeader(g.id);
    if (!leader) {
      leader = extractLeaderFromName(attr.name);
      console.log(`  ${attr.name}: using name-extracted leader "${leader}"`);
    } else {
      console.log(`  ${attr.name}: leader "${leader}"`);
    }

    let url = `https://groups.planningcenteronline.com/groups/${g.id}`;
    if (attr.public_church_center_web_url) {
      url = attr.public_church_center_web_url;
    } else if (attr.contact_email) {
      url = `mailto:${attr.contact_email}`;
    }

    output.push({
      id:          g.id,
      name:        attr.name,
      leader,
      description: attr.description_as_plain_text || '',
      schedule:    attr.schedule || '',
      photo:       attr.header_image && attr.header_image.medium ? attr.header_image.medium : '',
      url,
      lat,
      lng,
      synced_at:   new Date().toISOString()
    });
  }

  const result = {
    groups:    output,
    synced_at: new Date().toISOString()
  };

  fs.writeFileSync('groups.json', JSON.stringify(result, null, 2));
  console.log(`\nWrote ${output.length} groups to groups.json`);
}

main().catch(e => {
  console.error('Sync failed:', e);
  process.exit(1);
});
