import { db } from '../db/db'
import { isAiTestId } from './aiTestIsolation'
import type { AcousticEdge, Contact, LocationAudibility, LocationNode, TerrainType } from '../types'
import { createUpgradedWorldMap, createWorldMap, defaultTerrainsForIcon, MAP_GENERATOR_VERSION, MAP_SIZE, placeBuildings } from './locationMap'
import { useSettingsStore } from '../store/useSettingsStore'
import { resolveActiveTask, validateScheduleBlocks } from './schedule'
import { chatCompletionText } from './deepseek'
import { parseJsonLoose } from './aiProtocol'
import type { AppSettings, ScheduleBlock } from '../types'

export const LOCATION_GROUP_ID = 'talk-location-group'
export const LOCATION_CONVERSATION_ID = 'talk-location-conversation'
const MAP_SEED = 'talk-location-map-v1'

type LocationSeed = Pick<LocationNode, 'id' | 'parentId' | 'name' | 'kind' | 'description' | 'access' | 'sortOrder'>
const seed = (id: string, parentId: string | undefined, name: string, kind: string, description: string, sortOrder: number, access: LocationNode['access'] = 'public'): LocationSeed => ({ id, parentId, name, kind, description, access, sortOrder })

const LOCATION_SEEDS: LocationSeed[] = [
  seed('city', undefined, '临江市', 'world', '一座临河而建的现代城市。', 0),
  seed('home', 'city', '我的家', 'residence', '安静的私人住所。', 10, 'private'),
  seed('home-living', 'home', '客厅', 'living-room', '适合休息和闲聊的客厅。', 11, 'private'),
  seed('home-kitchen', 'home', '厨房', 'kitchen', '连着客厅的开放式厨房。', 12, 'private'),
  seed('riverside-apartment', 'city', '临江公寓', 'apartment', '靠近江岸的城市公寓。', 14),
  seed('riverside-apartment-lobby', 'riverside-apartment', '公寓大堂', 'lobby', '住户和访客经过的一层大堂。', 15),
  seed('riverside-apartment-room', 'riverside-apartment', '住户楼层', 'apartment-floor', '分布着不同住户房间的楼层。', 16, 'restricted'),
  seed('youth-apartment', 'city', '青年公寓', 'apartment', '许多年轻上班族居住的公寓。', 17),
  seed('youth-apartment-room', 'youth-apartment', '住户楼层', 'apartment-floor', '相对紧凑而便利的居住空间。', 18, 'restricted'),
  seed('student-dorm', 'city', '学生宿舍', 'dormitory', '供学生住宿的宿舍楼。', 19, 'restricted'),
  seed('student-dorm-room', 'student-dorm', '宿舍楼层', 'dorm-floor', '学生们日常生活的宿舍区域。', 20, 'restricted'),
  seed('old-residences', 'city', '老城区住宅', 'apartment', '街巷密集、生活气息浓厚的旧住宅区。', 21),
  seed('old-residences-lane', 'old-residences', '居民巷', 'residential-lane', '连接旧住宅楼的安静巷道。', 22),
  seed('villa-district', 'city', '郊外别墅区', 'villa', '位于丘陵边缘的低密度住宅区。', 23, 'restricted'),
  seed('villa-district-lane', 'villa-district', '林荫住宅道', 'villa-lane', '通向各栋住宅的林荫道路。', 24, 'restricted'),
  seed('school', 'city', '临江学校', 'school', '有教室、食堂和操场的校园。', 20, 'restricted'),
  seed('school-classroom', 'school', '教室', 'classroom', '上课与自习的教室。', 21, 'restricted'),
  seed('school-canteen', 'school', '食堂', 'canteen', '学生们集中用餐的地方。', 22),
  seed('school-playground', 'school', '操场', 'playground', '适合运动与散步的开阔场地。', 23),
  seed('university', 'city', '临江大学', 'university', '临江市规模最大的综合大学。', 24),
  seed('university-library', 'university', '大学图书馆', 'library', '安静宽敞的大学图书馆。', 25),
  seed('university-campus', 'university', '校园广场', 'campus-square', '连接教学楼和宿舍区的广场。', 26),
  seed('office', 'city', '临江中心', 'office', '城市里的办公楼。', 25),
  seed('office-floor', 'office', '办公区', 'office-floor', '安静忙碌的开放办公区。', 26, 'restricted'),
  seed('office-lobby', 'office', '大堂', 'lobby', '办公楼的一层公共大堂。', 27),
  seed('mall', 'city', '中心商场', 'mall', '人流密集的综合商场。', 30),
  seed('mall-atrium', 'mall', '商场中庭', 'atrium', '明亮开阔的商场中庭。', 31),
  seed('mall-cafe', 'mall', '咖啡店', 'cafe', '适合见面聊天的咖啡店。', 32),
  seed('mall-shop', 'mall', '商店', 'shop', '陈列着各种商品的店铺。', 33),
  seed('hospital', 'city', '市立医院', 'hospital', '提供门诊和住院服务的医院。', 40),
  seed('hospital-lobby', 'hospital', '医院大厅', 'lobby', '患者与访客往来的大厅。', 41),
  seed('hospital-clinic', 'hospital', '门诊室', 'clinic', '安静的门诊诊室。', 42, 'restricted'),
  seed('city-hall', 'city', '市政中心', 'city-hall', '处理城市公共事务的行政中心。', 43),
  seed('police', 'city', '临江警察局', 'police', '负责城区治安与公共安全。', 44, 'restricted'),
  seed('station', 'city', '临江车站', 'station', '连接城区和外地的综合车站。', 45),
  seed('commercial-street', 'city', '临江商业街', 'market', '餐饮、零售和夜间活动集中的街区。', 46),
  seed('commercial-street-restaurant', 'commercial-street', '餐厅街', 'restaurant-street', '汇集不同餐馆的小街。', 47),
  seed('commercial-street-cafe', 'commercial-street', '街角咖啡馆', 'cafe', '适合短暂休息和见面的咖啡馆。', 48),
  seed('market', 'city', '晴川市场', 'market', '附近居民采购日常用品的市场。', 49),
  seed('park', 'city', '临河公园', 'park', '沿河修建的城市公园。', 50),
  seed('park-lawn', 'park', '中央草坪', 'lawn', '适合散步、晒太阳和野餐。', 51),
  seed('park-riverside', 'park', '滨河步道', 'river-walk', '沿着河岸延伸的步行道。', 52),
  seed('cinema', 'city', '临江电影院', 'cinema', '位于商业区的多厅电影院。', 55),
  seed('harbor', 'city', '临江码头', 'harbor', '沿江货运与客运共用的码头。', 57),
  seed('beach', 'city', '白沙湾', 'beach', '城市近郊的公共沙滩。', 60),
  seed('beach-boardwalk', 'beach', '海滨步道', 'boardwalk', '能看见海面的木质步道。', 61),
  seed('mountain', 'city', '雾岭', 'mountain', '位于城市边缘的山地景区。', 70),
  seed('mountain-lookout', 'mountain', '山顶观景台', 'lookout', '可以俯瞰城市的观景台。', 71),
  seed('hills', 'city', '青岚丘陵', 'hill', '城市西北侧起伏舒缓的丘陵。', 72),
  seed('hills-trail', 'hills', '丘陵步道', 'hill-trail', '沿缓坡延伸的郊野步道。', 73),
  seed('farm', 'city', '晴川农场', 'farm', '位于乡村区域的农场。', 80, 'restricted'),
  seed('farm-field', 'farm', '农田', 'farmland', '开阔的田地。', 81, 'restricted'),
  seed('village', 'city', '南溪村', 'village', '位于城市南侧的近郊村庄。', 84),
  seed('village-square', 'village', '村口广场', 'village-square', '村民日常聚集的小广场。', 85),
  seed('industrial-park', 'city', '临江工业园', 'factory', '位于下游郊区的产业园区。', 88, 'restricted'),
  seed('industrial-park-gate', 'industrial-park', '园区入口', 'factory-gate', '人员车辆进出工业园的入口。', 89, 'restricted'),
]

const ROOT_SPECS: Array<{ id: string; allowedTerrains: TerrainType[]; buildingCategory: string }> = [
  { id: 'home', allowedTerrains: ['urban', 'rural'], buildingCategory: 'residence' },
  { id: 'riverside-apartment', allowedTerrains: ['urban'], buildingCategory: 'apartment' },
  { id: 'youth-apartment', allowedTerrains: ['urban'], buildingCategory: 'apartment' },
  { id: 'student-dorm', allowedTerrains: ['urban'], buildingCategory: 'dormitory' },
  { id: 'old-residences', allowedTerrains: ['urban'], buildingCategory: 'apartment' },
  { id: 'villa-district', allowedTerrains: ['rural', 'grassland', 'hill'], buildingCategory: 'villa' },
  { id: 'school', allowedTerrains: ['urban'], buildingCategory: 'school' },
  { id: 'university', allowedTerrains: ['urban'], buildingCategory: 'university' },
  { id: 'office', allowedTerrains: ['urban'], buildingCategory: 'office' },
  { id: 'mall', allowedTerrains: ['urban'], buildingCategory: 'mall' },
  { id: 'hospital', allowedTerrains: ['urban'], buildingCategory: 'hospital' },
  { id: 'city-hall', allowedTerrains: ['urban'], buildingCategory: 'city-hall' },
  { id: 'police', allowedTerrains: ['urban'], buildingCategory: 'police' },
  { id: 'station', allowedTerrains: ['urban', 'rural'], buildingCategory: 'station' },
  { id: 'commercial-street', allowedTerrains: ['urban'], buildingCategory: 'market' },
  { id: 'market', allowedTerrains: ['urban', 'rural'], buildingCategory: 'market' },
  { id: 'park', allowedTerrains: ['grassland'], buildingCategory: 'park' },
  { id: 'cinema', allowedTerrains: ['urban'], buildingCategory: 'cinema' },
  { id: 'harbor', allowedTerrains: ['beach', 'grassland', 'rural'], buildingCategory: 'harbor' },
  { id: 'beach', allowedTerrains: ['beach'], buildingCategory: 'beach' },
  { id: 'mountain', allowedTerrains: ['mountain'], buildingCategory: 'scenic' },
  { id: 'hills', allowedTerrains: ['hill'], buildingCategory: 'hill' },
  { id: 'farm', allowedTerrains: ['rural'], buildingCategory: 'farm' },
  { id: 'village', allowedTerrains: ['rural', 'grassland'], buildingCategory: 'village' },
  { id: 'industrial-park', allowedTerrains: ['urban', 'rural'], buildingCategory: 'factory' },
]

const edge = (fromLocationId: string, toLocationId: string, audibility: LocationAudibility): AcousticEdge => ({
  id: `${fromLocationId}:${toLocationId}`,
  fromLocationId,
  toLocationId,
  audibility,
  bidirectional: true,
})

const ACOUSTIC_SEEDS: AcousticEdge[] = [
  edge('home-living', 'home-kitchen', 'clear'),
  edge('school-classroom', 'school-canteen', 'muffled'),
  edge('school-canteen', 'school-playground', 'muffled'),
  edge('office-floor', 'office-lobby', 'muffled'),
  edge('mall-atrium', 'mall-cafe', 'clear'),
  edge('mall-atrium', 'mall-shop', 'clear'),
  edge('mall-cafe', 'mall-shop', 'muffled'),
  edge('hospital-lobby', 'hospital-clinic', 'muffled'),
  edge('park-lawn', 'park-riverside', 'clear'),
]

let initialization: Promise<void> | undefined
export function ensureLocationsInitialized() {
  if (!initialization) initialization = (async () => {
    const existingMap = await db.worldMaps.get('active')
    const existingLocations = await db.locations.toArray()
    const existingLocationIds = new Set(existingLocations.map((item) => item.id))
    const state = await db.locationModuleState.get('active')
    const deletedLocationIds = new Set(state?.deletedLocationIds ?? [])
    const missingLocations = LOCATION_SEEDS.filter((item) => !existingLocationIds.has(item.id) && !deletedLocationIds.has(item.id))
    const builtInRootIds = new Set(ROOT_SPECS.map((item) => item.id))
    const missingRoot = missingLocations.some((item) => builtInRootIds.has(item.id))
    const shouldRebuild = !existingMap || existingMap.generatorVersion < MAP_GENERATOR_VERSION || existingMap.width !== MAP_SIZE || existingMap.height !== MAP_SIZE || missingRoot
    const map = !existingMap ? createWorldMap(MAP_SEED) : shouldRebuild ? createUpgradedWorldMap(existingMap) : existingMap
    const now = Date.now()
    const merged = [...existingLocations, ...missingLocations.map((item) => ({ ...item, createdAt: now, updatedAt: now } as LocationNode))]

    if (shouldRebuild) {
      const builtInSpecs = new Map(ROOT_SPECS.map((item) => [item.id, item]))
      const roots = merged.filter((item) => item.mapBinding || builtInSpecs.has(item.id))
      const specs = roots.map((item) => builtInSpecs.get(item.id) ?? {
        id: item.id,
        allowedTerrains: item.mapBinding?.allowedTerrains ?? defaultTerrainsForIcon(item.mapBinding?.iconId ?? item.mapBinding?.buildingCategory ?? 'custom'),
        buildingCategory: item.mapBinding?.buildingCategory ?? item.mapBinding?.iconId ?? 'custom',
      })
      const bindings = placeBuildings(map, specs)
      if (bindings.size !== specs.length) throw new Error(`地图空间不足，无法安排：${specs.filter((item) => !bindings.has(item.id)).map((item) => item.id).join('、')}`)
      await db.transaction('rw', db.worldMaps, db.locations, async () => {
        await db.worldMaps.put(map)
        await db.locations.bulkPut(merged.map((item) => {
          const binding = bindings.get(item.id)
          return {
            ...item,
            mapBinding: binding ? { ...binding, iconId: item.mapBinding?.iconId ?? binding.iconId, customIconDataUrl: item.mapBinding?.customIconDataUrl } : item.mapBinding,
            updatedAt: now,
          }
        }))
      })
    } else if (missingLocations.length) {
      await db.locations.bulkPut(missingLocations.map((item) => ({ ...item, createdAt: now, updatedAt: now })))
    }

    const nickname = useSettingsStore.getState().userNickname.trim()
    const homeName = nickname && nickname !== '我' ? `${nickname}的家` : '我的家'
    const home = await db.locations.get('home')
    if (home && home.name !== homeName) await db.locations.update('home', { name: homeName, updatedAt: now })
    const existingEdgeIds = new Set((await db.acousticEdges.toArray()).map((item) => item.id))
    const missingEdges = ACOUSTIC_SEEDS.filter((item) => !existingEdgeIds.has(item.id))
    if (missingEdges.length) await db.acousticEdges.bulkPut(missingEdges)
    if (!await db.locationModuleState.get('active')) await db.locationModuleState.put({ id: 'active', updatedAt: Date.now() })
  })().finally(() => { initialization = undefined })
  return initialization
}

export function childLocations(parentId: string, locations: LocationNode[]) {
  return locations.filter((item) => item.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder)
}

export function locationTreeIds(locationId: string, locations: LocationNode[]) {
  const ids = new Set([locationId])
  let changed = true
  while (changed) {
    changed = false
    for (const location of locations) {
      if (location.parentId && ids.has(location.parentId) && !ids.has(location.id)) {
        ids.add(location.id)
        changed = true
      }
    }
  }
  return ids
}

/** Remove a location subtree and every runtime reference that could point into it. */
export async function deleteLocationTree(locationId: string) {
  const locations = await db.locations.toArray()
  const deletedIds = locationTreeIds(locationId, locations)
  const state = await db.locationModuleState.get('active')
  const deletedBuiltIns = locations
    .filter((location) => deletedIds.has(location.id) && !location.userCreated)
    .map((location) => location.id)
  const nextDeletedIds = [...new Set([...(state?.deletedLocationIds ?? []), ...deletedBuiltIns])]
  const affectedContacts = (await db.contacts.toArray()).filter((contact) => contact.currentLocationId && deletedIds.has(contact.currentLocationId))
  const affectedEdges = (await db.acousticEdges.toArray())
    .filter((edge) => deletedIds.has(edge.fromLocationId) || deletedIds.has(edge.toLocationId))

  await db.transaction('rw', db.locations, db.contacts, db.locationModuleState, db.acousticEdges, async () => {
    await db.locations.bulkDelete([...deletedIds])
    if (affectedEdges.length) await db.acousticEdges.bulkDelete(affectedEdges.map((edge) => edge.id))
    if (affectedContacts.length) await db.contacts.bulkUpdate(affectedContacts.map((contact) => ({
      key: contact.id,
      changes: { currentLocationId: undefined, locationSource: 'unknown', locationUpdatedAt: Date.now() },
    })))
    await db.locationModuleState.put({
      id: 'active',
      currentLocationId: state?.currentLocationId && deletedIds.has(state.currentLocationId) ? undefined : state?.currentLocationId,
      deletedLocationIds: nextDeletedIds,
      updatedAt: Date.now(),
    })
  })
}

export function isLeafLocation(id: string, locations: LocationNode[]) {
  return !locations.some((item) => item.parentId === id)
}

/**
 * A deleted location deliberately leaves its occupants at "unknown". Their
 * next direct conversation uses the utility model once to choose a valid
 * current leaf and repair the location IDs in their recurring schedule.
 */
export async function reassignUnknownContactLocation(contact: Contact, settings: AppSettings) {
  if (contact.locationSource !== 'unknown') return false
  await ensureLocationsInitialized()
  const locations = await db.locations.toArray()
  const leaves = locations.filter((location) => isLeafLocation(location.id, locations))
  if (!leaves.length || !settings.apiKey) return false
  const catalog = leaves.map((location) => `${location.id}=${location.name}`).join('；')
  try {
    const raw = await chatCompletionText({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      provider: settings.aiProvider,
      model: settings.utilityModel || settings.model,
      purpose: 'persona',
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 3000,
      messages: [{ role: 'system', content: `你负责在地点被删除后修复联系人位置。只能使用下方合法地点 ID；根据人设、职业和既有日程选择一个当前具体地点，并重写每周固定日程，使每条日程同时包含 location（自然语言地点名）和 locationId（合法具体地点 ID）。保留人物职业、作息和合理性。只输出 JSON：{"currentLocationId":"...","schedule":[...] }。\n联系人：${contact.name}\n人设：${contact.systemPrompt}\n职业：${contact.occupation ?? '未设置'}\n原日程：${JSON.stringify(contact.schedule ?? [])}\n合法地点：${catalog}` }],
    })
    const parsed = parseJsonLoose<{ currentLocationId?: unknown; schedule?: unknown }>(raw) ?? {}
    const validIds = new Set(leaves.map((location) => location.id))
    const currentLocationId = typeof parsed.currentLocationId === 'string' && validIds.has(parsed.currentLocationId) ? parsed.currentLocationId : undefined
    const schedule = validateScheduleBlocks(parsed.schedule).map((item) => validIds.has(item.locationId ?? '') ? item : { ...item, locationId: currentLocationId })
    if (!currentLocationId || schedule.length === 0) return false
    await db.contacts.update(contact.id, { currentLocationId, locationSource: 'schedule', locationUpdatedAt: Date.now(), schedule: schedule as ScheduleBlock[] })
    return true
  } catch (error) {
    console.warn('[locations] unknown location reassignment failed', error)
    return false
  }
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const KEYWORD_LOCATIONS: Array<[RegExp, string[]]> = [
  [/学校|教室|上课|自习/, ['school-classroom']],
  [/食堂|吃饭|午餐|晚餐/, ['school-canteen', 'mall-cafe']],
  [/操场|体育课|运动/, ['school-playground', 'park-lawn']],
  [/公司|办公室|办公|上班|工作/, ['office-floor', 'office-lobby']],
  [/咖啡/, ['mall-cafe']],
  [/商场|购物|逛街|商店/, ['mall-atrium', 'mall-shop']],
  [/医院|门诊|看病/, ['hospital-lobby', 'hospital-clinic']],
  [/公园|草坪|野餐/, ['park-lawn', 'park-riverside']],
  [/河边|步道|散步/, ['park-riverside', 'beach-boardwalk']],
  [/海|沙滩/, ['beach-boardwalk']],
  [/山|登山|观景/, ['mountain-lookout']],
  [/农场|农田/, ['farm-field']],
]

const NPC_HOME_LOCATIONS = ['riverside-apartment-room', 'youth-apartment-room', 'student-dorm-room', 'old-residences-lane', 'villa-district-lane']
const PLAYER_HOME_LOCATION_IDS = new Set(['home-living', 'home-kitchen'])

/** A contact can genuinely live with the player. Keep their explicitly
 * generated household routine at the player's home instead of treating it as
 * the old generic "everyone sleeps here" generation mistake. */
function isPlayerHomeResident(contact: Contact) {
  if (contact.residence) return contact.residence.cohabitsWithUser
  return /女仆|佣人|管家|保姆|住家|同居|室友|妹妹|姐姐|弟弟|哥哥|家人|妻子|丈夫|未婚妻|未婚夫/.test([
    contact.relationshipBase,
    contact.relationshipDynamic,
    contact.systemPrompt,
  ].filter(Boolean).join(' '))
}

export function isPlayerHomeLocation(locationId?: string) {
  return !!locationId && PLAYER_HOME_LOCATION_IDS.has(locationId)
}

/** Existing contacts retain their inferred household status; new ones persist it in `residence`. */
export function residenceLocationId(contact: Contact, validLocationIds: Set<string>) {
  if (contact.residence?.locationId && validLocationIds.has(contact.residence.locationId)) return contact.residence.locationId
  if (isPlayerHomeResident(contact) && validLocationIds.has('home-living')) return 'home-living'
  const profile = `${contact.occupation ?? ''} ${contact.creatorProfile?.occupation ?? ''} ${contact.systemPrompt}`
  const candidates = /学生|大学|高中|初中|学校|上课/.test(profile)
    ? ['student-dorm-room', ...NPC_HOME_LOCATIONS]
    : NPC_HOME_LOCATIONS
  return candidates.find((id) => validLocationIds.has(id)) ?? [...validLocationIds][0]
}

export function canUsePlayerHome(contact: Contact, locationId: string, playerHomeVisit = false) {
  return !isPlayerHomeLocation(locationId) || isPlayerHomeResident(contact) || playerHomeVisit
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

export function mapNaturalLocation(text: string, contactId: string, timeKey: string, validLocationIds: Set<string>): string | undefined {
  for (const [pattern, candidates] of KEYWORD_LOCATIONS) {
    if (!pattern.test(text)) continue
    const valid = candidates.filter((id) => validLocationIds.has(id))
    if (valid.length) return valid[stableHash(`${contactId}:${timeKey}:${text}`) % valid.length]
  }
  return undefined
}

export interface ResolvedContactRuntime {
  locationId: string
  source: 'schedule' | 'specialTask' | 'manual' | 'fallback'
  taskId?: string
  taskKind?: 'default' | 'special'
  activity?: string
}

export function resolveContactRuntimeAt(contact: Contact, now: Date, validLocationIds: Set<string>): ResolvedContactRuntime {
  const active = resolveActiveTask(contact, now)
  if (active?.kind === 'special' && active.task.locationId && validLocationIds.has(active.task.locationId) && canUsePlayerHome(contact, active.task.locationId, 'playerHomeVisit' in active.task && active.task.playerHomeVisit)) return { locationId: active.task.locationId, source: 'specialTask', taskId: active.task.id, taskKind: 'special', activity: active.task.activity }
  if (contact.locationSource === 'manual' && contact.currentLocationId && validLocationIds.has(contact.currentLocationId)) return { locationId: contact.currentLocationId, source: 'manual', taskId: active?.task.id, taskKind: active?.kind, activity: active?.task.activity }
  // "我的家" is the player's private space, not a generic NPC residence. Older
  // persona-generation examples accidentally used it for every contact's
  // nightly routine; keep those legacy schedules from gathering everyone in
  // the player's living room while preserving explicit one-off visits above.
  const isLegacyPlayerHomeRest = active?.kind === 'default'
    && (active.task.locationId === 'home-living' || active.task.locationId === 'home-kitchen')
    && /卧室|家里|在家|住宅|睡觉|休息|午休|补觉/.test(`${active.task.location} ${active.task.activity}`)
    && !isPlayerHomeResident(contact)
  if (isLegacyPlayerHomeRest) {
    const homes = NPC_HOME_LOCATIONS.filter((id) => validLocationIds.has(id))
    if (homes.length) return { locationId: homes[stableHash(contact.id) % homes.length], source: 'schedule', taskId: active.task.id, taskKind: 'default', activity: active.task.activity }
  }
  if (active?.task.locationId && validLocationIds.has(active.task.locationId) && canUsePlayerHome(contact, active.task.locationId)) return { locationId: active.task.locationId, source: 'schedule', taskId: active.task.id, taskKind: active.kind, activity: active.task.activity }
  const timeKey = `${localDateKey(now)}:${active?.task.id ?? Math.floor(now.getHours() / 4)}`
  const scheduleText = `${active?.task.location ?? ''} ${active?.task.activity ?? ''}`
  if (/卧室|家里|在家|住宅|睡觉|休息/.test(scheduleText)) {
    const homes = NPC_HOME_LOCATIONS.filter((id) => validLocationIds.has(id))
    if (homes.length) return { locationId: homes[stableHash(contact.id) % homes.length], source: active ? active.kind === 'special' ? 'specialTask' : 'schedule' : 'fallback', taskId: active?.task.id, taskKind: active?.kind, activity: active?.task.activity }
  }
  const mapped = mapNaturalLocation(scheduleText, contact.id, timeKey, validLocationIds)
  if (mapped) return { locationId: mapped, source: active ? active.kind === 'special' ? 'specialTask' : 'schedule' : 'fallback', taskId: active?.task.id, taskKind: active?.kind, activity: active?.task.activity }
  // No active task means returning to/staying at the residence. Public places
  // are never a random fallback: every map location needs a living reason.
  return { locationId: residenceLocationId(contact, validLocationIds), source: 'fallback', taskId: active?.task.id, taskKind: active?.kind, activity: active?.task.activity }
}

export function resolveContactLocationAt(contact: Contact, now: Date, validLocationIds: Set<string>): { locationId: string; source: 'schedule' | 'manual' | 'fallback' | 'specialTask' } {
  const { locationId, source } = resolveContactRuntimeAt(contact, now, validLocationIds)
  return { locationId, source }
}

/** Synchronizes one explicitly selected contact. Unlike the world-wide sync,
 * this also supports isolated ai-test contacts without exposing them to the
 * live location participant list. */
export async function syncContactLocationAt(contactId: string, now = new Date()) {
  await ensureLocationsInitialized()
  const [locations, contact] = await Promise.all([db.locations.toArray(), db.contacts.get(contactId)])
  if (!contact) return false
  if (contact.locationSource === 'unknown') return false
  const leafIds = new Set(locations.filter((item) => isLeafLocation(item.id, locations)).map((item) => item.id))
  const resolved = resolveContactRuntimeAt(contact, now, leafIds)
  const changed = contact.currentLocationId !== resolved.locationId || contact.locationSource !== resolved.source || contact.currentTaskId !== resolved.taskId || contact.currentTaskKind !== resolved.taskKind || contact.currentActivity !== resolved.activity
  if (changed) await db.contacts.update(contact.id, { currentLocationId: resolved.locationId, locationSource: resolved.source, locationUpdatedAt: now.getTime(), currentTaskId: resolved.taskId, currentTaskKind: resolved.taskKind, currentActivity: resolved.activity, taskUpdatedAt: now.getTime() })
  return changed
}

export async function syncContactLocationsAt(now = new Date()) {
  await ensureLocationsInitialized()
  const [locations, contacts] = await Promise.all([db.locations.toArray(), db.contacts.toArray().then((items) => items.filter((item) => !isAiTestId(item.id)))])
  const leafIds = new Set(locations.filter((item) => isLeafLocation(item.id, locations)).map((item) => item.id))
  const updates = contacts.filter((contact) => contact.locationSource !== 'unknown').map((contact) => ({ contact, resolved: resolveContactRuntimeAt(contact, now, leafIds) }))
    .filter(({ contact, resolved }) => contact.currentLocationId !== resolved.locationId || contact.locationSource !== resolved.source || contact.currentTaskId !== resolved.taskId || contact.currentTaskKind !== resolved.taskKind || contact.currentActivity !== resolved.activity)
  if (updates.length) await db.contacts.bulkUpdate(updates.map(({ contact, resolved }) => ({ key: contact.id, changes: { currentLocationId: resolved.locationId, locationSource: resolved.source, locationUpdatedAt: now.getTime(), currentTaskId: resolved.taskId, currentTaskKind: resolved.taskKind, currentActivity: resolved.activity, taskUpdatedAt: now.getTime() } })))
  return updates.length
}

export interface LocationParticipants {
  here: Contact[]
  audible: Array<{ contact: Contact; audibility: 'clear' | 'muffled' }>
  away: Contact[]
  activeMembers: Contact[]
}

export async function resolveLocationParticipants(locationId: string): Promise<LocationParticipants> {
  await ensureLocationsInitialized()
  const [contacts, edges] = await Promise.all([db.contacts.toArray().then((items) => items.filter((item) => !isAiTestId(item.id))), db.acousticEdges.toArray()])
  const audibleByLocation = new Map<string, 'clear' | 'muffled'>()
  for (const item of edges) {
    if (item.audibility === 'none') continue
    if (item.fromLocationId === locationId) audibleByLocation.set(item.toLocationId, item.audibility)
    if (item.bidirectional && item.toLocationId === locationId) audibleByLocation.set(item.fromLocationId, item.audibility)
  }
  const here: Contact[] = [], audible: LocationParticipants['audible'] = [], away: Contact[] = []
  for (const contact of contacts) {
    if (contact.currentLocationId === locationId) here.push(contact)
    else {
      const audibility = contact.currentLocationId ? audibleByLocation.get(contact.currentLocationId) : undefined
      if (audibility) audible.push({ contact, audibility })
      else away.push(contact)
    }
  }
  return { here, audible, away, activeMembers: [...here, ...audible.map((item) => item.contact)] }
}

export function locationCounts(contacts: Contact[], locations: LocationNode[]) {
  const direct = new Map<string, number>()
  for (const contact of contacts) if (contact.currentLocationId) direct.set(contact.currentLocationId, (direct.get(contact.currentLocationId) ?? 0) + 1)
  const byId = new Map(locations.map((item) => [item.id, item]))
  const aggregate = new Map(direct)
  for (const [id, count] of direct) {
    let parentId = byId.get(id)?.parentId
    while (parentId) {
      aggregate.set(parentId, (aggregate.get(parentId) ?? 0) + count)
      parentId = byId.get(parentId)?.parentId
    }
  }
  return aggregate
}

/** Rebuild terrain and redistribute every top-level marker without deleting place data. */
export async function regenerateLocationMap(seed?: string) {
  await ensureLocationsInitialized()
  const current = await db.worldMaps.get('active')
  if (!current) return undefined
  const roots = (await db.locations.toArray()).filter((item) => item.mapBinding)
  const specs = roots.map((item) => ({
    id: item.id,
    allowedTerrains: item.mapBinding!.allowedTerrains.length ? item.mapBinding!.allowedTerrains : defaultTerrainsForIcon(item.mapBinding!.iconId ?? item.mapBinding!.buildingCategory),
    buildingCategory: item.mapBinding!.buildingCategory,
  }))
  let next = createUpgradedWorldMap(current, seed ?? `talk-location-map-${crypto.randomUUID()}`)
  let bindings = placeBuildings(next, specs)
  for (let attempt = 1; !seed && bindings.size !== roots.length && attempt < 8; attempt += 1) {
    next = createUpgradedWorldMap(current, `talk-location-map-${crypto.randomUUID()}`)
    bindings = placeBuildings(next, specs)
  }
  if (bindings.size !== roots.length) throw new Error('没有生成出足够的合法空位，请再试一次')
  await db.transaction('rw', db.worldMaps, db.locations, async () => {
    await db.worldMaps.put(next)
    for (const location of roots) {
      const binding = bindings.get(location.id)
      if (binding) await db.locations.update(location.id, { mapBinding: { ...binding, iconId: location.mapBinding?.iconId ?? binding.iconId, customIconDataUrl: location.mapBinding?.customIconDataUrl }, updatedAt: Date.now() })
    }
  })
  return next
}

/** Legacy alias retained for older callers and imported UI state. */
export const upgradeLocationMap = regenerateLocationMap

export async function enterLocation(locationId: string) {
  await syncContactLocationsAt(new Date())
  const [location, allLocations] = await Promise.all([db.locations.get(locationId), db.locations.toArray()])
  if (!location || !isLeafLocation(location.id, allLocations)) throw new Error('请选择建筑内的具体地点')
  const participants = await resolveLocationParticipants(location.id)
  const now = Date.now()
  const existingGroup = await db.groups.get(LOCATION_GROUP_ID)
  const worldviewId = useSettingsStore.getState().activeWorldId || useSettingsStore.getState().defaultWorldviewId
  const worldMembers = participants.activeMembers
  await db.transaction('rw', db.groups, db.conversations, db.locationModuleState, async () => {
    await db.groups.put({
      id: LOCATION_GROUP_ID, name: '地点群聊', avatar: '📍', avatarColor: '#7c3aed',
      memberContactIds: worldMembers.map((contact) => contact.id), worldviewId,
      memory: existingGroup?.memory,
      speakerLimit: existingGroup?.speakerLimit ?? 3,
      energyLevel: existingGroup?.energyLevel ?? 'normal', memoryTurnCount: existingGroup?.memoryTurnCount,
      memoryMessageCursor: existingGroup?.memoryMessageCursor, momentSharing: existingGroup?.momentSharing ?? 'private',
      createdAt: existingGroup?.createdAt ?? now, kind: 'location', locationId: location.id,
    })
    const existingConversation = await db.conversations.get(LOCATION_CONVERSATION_ID)
    await db.conversations.put({ id: LOCATION_CONVERSATION_ID, groupId: LOCATION_GROUP_ID, pinned: true, systemPinned: true, createdAt: existingConversation?.createdAt ?? now, updatedAt: now, lastReadAt: existingConversation?.lastReadAt })
    await db.locationModuleState.put({ id: 'active', currentLocationId: location.id, updatedAt: now })
  })
  return LOCATION_CONVERSATION_ID
}

export function realSeason(date = new Date()) {
  const month = date.getMonth() + 1
  if (month >= 3 && month <= 5) return '春季'
  if (month >= 6 && month <= 8) return '夏季'
  if (month >= 9 && month <= 11) return '秋季'
  return '冬季'
}
