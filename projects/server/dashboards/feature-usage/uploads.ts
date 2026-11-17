/**
 * The Uploads tab: who uploads, what the upload form records, and what the screenshots show, from
 * the screenshots the server stored, whatever the uploader's mod version or usage statistics.
 */

import type { Prisma } from '#prisma-lib/client';
import { dottedField, isInLastWeeks, ratioExpression, weekOf } from '../expressions';
import type { Column, FeatureUsageCard } from './dashboard';

/**
 * Ended weeks the series of uploaders covers.
 */
const seriesWeeks = 26;

/**
 * Ended weeks the cards on captures count the uploads of.
 */
const captureWeeks = 12;

/**
 * Weeks of each period of Upload form choices.
 */
const periodWeeks = 4;

/**
 * When the mod release adding the upload form's description and sharing toggles reached players.
 */
const uploadFormRelease = '2026-01-09';

const uploaderKinds = [
  { label: 'First upload', color: '#88BF4D' },
  { label: 'Returning uploader', color: '#509EE3' }
] as const;

/**
 * Choices of the upload form, each an expression of whether an upload made it.
 */
const formChoices = [
  {
    label: 'Wrote a description',
    color: '#509EE3',
    made: { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$description', ''] } } } }, 0] }
  },
  // Through $ifNull, as an unset field compares unequal to null.
  {
    label: 'Showcased an asset',
    color: '#A989C5',
    made: { $ne: [{ $ifNull: ['$showcasedModId', null] }, null] }
  },
  { label: 'Hid their playset', color: '#F2A86F', made: { $eq: ['$shareParadoxModIds', false] } },
  {
    label: 'Hid photo mode settings',
    color: '#EF8C8C',
    made: { $eq: ['$shareRenderSettings', false] }
  }
] as const;

/**
 * Labels of the families of photo mode settings, keyed by the family as {@link settingFamily}
 * names it; an unlisted family shows under its key.
 */
const settingFamilies: Readonly<Record<string, string>> = {
  'Time of Day': 'Time of day',
  'PhotoModeRenderSystem.focalLength': 'Focal length',
  'PhotoModeRenderSystem.sensorSize': 'Sensor size',
  'PhotoModeRenderSystem.iso': 'ISO',
  'PhotoModeRenderSystem.aperture': 'Aperture',
  'PhotoModeRenderSystem.shutterSpeed': 'Shutter speed',
  'PhotoModeRenderSystem.lensShift': 'Lens shift',
  'PhotoModeRenderSystem.gateFitMode': 'Gate fit',
  'PhotoModeRenderSystem.curvature': 'Curvature',
  'PhotoModeRenderSystem.anamorphism': 'Anamorphism',
  'PhotoModeRenderSystem.barrelClipping': 'Barrel clipping',
  'PhotoModeRenderSystem.bladeCount': 'Blade count',
  'DepthOfField': 'Depth of field',
  'ColorAdjustments': 'Color adjustments',
  'CloudLayer': 'Cloud layer',
  'ShadowsMidtonesHighlights': 'Shadows, midtones, highlights',
  'WhiteBalance': 'White balance',
  'VolumetricClouds': 'Volumetric clouds',
  'FilmGrain': 'Film grain',
  'MotionBlur': 'Motion blur',
  'PhysicallyBasedSky': 'Physically based sky',
  'PaniniProjection': 'Panini projection',
  'Env': 'Time of day easing'
};

/**
 * Families of photo mode settings shown, the most changed first.
 */
const shownFamilies = 15;

const nothingChanged = 'Nothing changed';

/**
 * An aspect of the scene, from the conditions the mod records with each capture.
 */
interface SceneAspect {
  readonly name: string;

  readonly column: SceneColumn;

  readonly description: string;

  readonly key: string;

  /**
   * The aspect's groups, in display order, each with the values it gathers.
   */
  readonly groups: ReadonlyArray<Readonly<{ label: string; values: readonly string[] }>>;
}

type SceneColumn = Extract<Column, 'dayPhase' | 'season' | 'weather' | 'theme'>;

const sceneAspects: readonly SceneAspect[] = [
  {
    name: 'Time of day of uploads, last 12 weeks',
    column: 'dayPhase',
    description: `Share of the uploads of the last 12 ended weeks captured at each phase of the day.`,
    key: 'light.dayPhase',
    groups: ['Dawn', 'Sunrise', 'Day', 'Sunset', 'Dusk', 'Night'].map(phase => ({
      label: phase,
      values: [phase]
    }))
  },
  {
    name: 'Season of uploads, last 12 weeks',
    column: 'season',
    description: `Share of the uploads of the last 12 ended weeks captured in each season.`,
    key: 'climate.season',
    groups: ['Spring', 'Summer', 'Autumn', 'Winter'].map(season => ({
      label: season,
      values: [`Season${season}`]
    }))
  },
  {
    name: 'Weather of uploads, last 12 weeks',
    column: 'weather',
    description: `Share of the uploads of the last 12 ended weeks captured in each weather.`,
    key: 'climate.weather',
    groups: [
      { label: 'Clear', values: ['Clear'] },
      { label: 'Partly cloudy', values: ['Few', 'Scattered'] },
      { label: 'Cloudy', values: ['Broken', 'Overcast'] },
      { label: 'Rain', values: ['Rain'] },
      { label: 'Snow', values: ['Snow'] },
      { label: 'Storm', values: ['Storm'] }
    ]
  },
  {
    name: 'City theme of uploads, last 12 weeks',
    column: 'theme',
    description: `Share of the uploads of the last 12 ended weeks by their city's theme; a theme from a mod shows as Other.`,
    key: 'city.theme',
    groups: [
      { label: 'European', values: ['European'] },
      { label: 'North American', values: ['North American'] }
    ]
  }
];

export const uploadsLastWeek: FeatureUsageCard = {
  name: 'Uploads',
  description: `Screenshots uploaded last week, against the week before.`,
  collection: 'screenshots',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'uploads' },
  pipeline: () => weeklyUploadStages()
};

export const uploadersLastWeek: FeatureUsageCard = {
  name: 'Uploaders',
  description: `Players who uploaded at least one screenshot last week, against the week before.`,
  collection: 'screenshots',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'uploaders' },
  pipeline: () => weeklyUploadStages()
};

export const firstTimeUploadersLastWeek: FeatureUsageCard = {
  name: 'First-time uploaders',
  description: `Players whose first upload ever fell last week, against the week before.`,
  collection: 'screenshots',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'firstTimeUploaders' },
  pipeline: () => weeklyUploadStages()
};

export const uploadsPerUploaderLastWeek: FeatureUsageCard = {
  name: 'Uploads per uploader',
  description: `Screenshots uploaded last week per player who uploaded, against the week before.`,
  collection: 'screenshots',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'uploadsPerUploader' },
  pipeline: () => weeklyUploadStages()
};

export const uploadersPerWeek: FeatureUsageCard = {
  name: 'Uploaders per week',
  description: `Players who uploaded at least one screenshot each week, split between those whose first upload ever fell that week and those who uploaded before.`,
  collection: 'screenshots',
  chart: {
    display: 'bar',
    dimensions: ['week', 'kind'],
    metric: 'uploaders',
    stacking: 'stacked',
    seriesColors: Object.fromEntries(uploaderKinds.map(kind => [kind.label, kind.color]))
  },
  pipeline: () => [
    // Every upload, so a first upload is the first ever and not the first of the series.
    {
      $group: {
        _id: '$creatorId',
        firstUploadAt: { $min: '$createdAt' },
        weeks: {
          $addToSet: {
            $cond: [isInLastWeeks('$createdAt', seriesWeeks), weekOf('$createdAt'), '$$REMOVE']
          }
        }
      }
    },
    { $unwind: '$weeks' },
    {
      $group: {
        _id: {
          week: '$weeks',
          kind: { $cond: [{ $eq: ['$weeks', weekOf('$firstUploadAt')] }, 0, 1] }
        },
        uploaders: { $sum: 1 }
      }
    },
    { $sort: { '_id.week': 1, '_id.kind': 1 } },
    {
      $project: {
        _id: 0,
        week: '$_id.week',
        kind: { $arrayElemAt: [uploaderKinds.map(kind => kind.label), '$_id.kind'] },
        uploaders: 1
      }
    }
  ]
};

export const uploadFormChoices: FeatureUsageCard = {
  name: 'Upload form choices, per 4 weeks',
  description: `Share of each 4-week period's uploaders who made each choice of the upload form on at least one upload, in the whole periods since the form's release on ${uploadFormRelease}. A player uploads several screenshots in a period, so it counts uploaders rather than uploads, which a few prolific players would weigh.`,
  collection: 'screenshots',
  chart: {
    display: 'line',
    dimensions: ['period', 'choice'],
    metric: 'uploaderShare',
    isPercent: true,
    seriesColors: Object.fromEntries(formChoices.map(choice => [choice.label, choice.color]))
  },
  pipeline: () => [
    { $match: { $expr: { $lt: ['$createdAt', weekOf('$$NOW')] } } },
    { $addFields: { period: periodExpression('$createdAt') } },
    // Whole periods since the release: a period started before it holds uploads without the form.
    { $match: { $expr: { $gte: ['$period', { $toDate: uploadFormRelease }] } } },
    {
      $group: {
        _id: { creatorId: '$creatorId', period: '$period' },
        ...Object.fromEntries(
          formChoices.map((choice, index) => [
            `choice${index}`,
            { $max: { $cond: [choice.made, 1, 0] } }
          ])
        )
      }
    },
    {
      $group: {
        _id: '$_id.period',
        uploaders: { $sum: 1 },
        ...Object.fromEntries(
          formChoices.map((_, index) => [`choice${index}`, { $sum: `$choice${index}` }])
        )
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        period: '$_id',
        rows: formChoices.map((choice, index) => ({
          choice: choice.label,
          uploaderShare: ratioExpression(`$choice${index}`, '$uploaders')
        }))
      }
    },
    { $unwind: '$rows' },
    { $project: { period: 1, choice: '$rows.choice', uploaderShare: '$rows.uploaderShare' } }
  ]
};

export const photoModeSettingsChanged: FeatureUsageCard = {
  name: 'Photo mode settings changed, last 12 weeks',
  description: `Share of the uploaders of the last 12 ended weeks who shared their photo mode settings that changed each family of settings on at least one upload, the ${shownFamilies} most changed shown, then those who changed none on any upload.`,
  collection: 'screenshots',
  chart: {
    display: 'row',
    dimensions: ['setting', 'kind'],
    metric: 'uploaderShare',
    isPercent: true,
    stacking: 'stacked',
    height: 9,
    seriesColors: { Changed: '#509EE3', [nothingChanged]: '#B8BBC3' }
  },
  pipeline: () => [
    {
      $match: {
        shareRenderSettings: true,
        $expr: isInLastWeeks('$createdAt', captureWeeks)
      }
    },
    {
      $group: {
        _id: '$creatorId',
        families: {
          $push: { $map: { input: { $objectToArray: '$renderSettings' }, in: settingFamily() } }
        }
      }
    },
    {
      $project: {
        families: {
          $reduce: {
            input: '$families',
            initialValue: [],
            in: { $setUnion: ['$$value', '$$this'] }
          }
        }
      }
    },
    {
      $facet: {
        uploaders: [{ $count: 'count' }],
        families: [
          { $unwind: '$families' },
          { $group: { _id: '$families', uploaders: { $sum: 1 } } },
          { $sort: { uploaders: -1, _id: 1 } },
          { $limit: shownFamilies }
        ],
        unchanged: [{ $match: { families: { $size: 0 } } }, { $count: 'count' }]
      }
    },
    {
      $project: {
        uploaders: { $ifNull: [{ $first: '$uploaders.count' }, 0] },
        rows: {
          $concatArrays: [
            {
              $map: {
                input: '$families',
                in: {
                  setting: familyLabel('$$this._id'),
                  kind: 'Changed',
                  count: '$$this.uploaders'
                }
              }
            },
            [
              {
                setting: nothingChanged,
                kind: nothingChanged,
                count: { $ifNull: [{ $first: '$unchanged.count' }, 0] }
              }
            ]
          ]
        }
      }
    },
    { $unwind: '$rows' },
    {
      $project: {
        _id: 0,
        setting: '$rows.setting',
        kind: '$rows.kind',
        uploaderShare: ratioExpression('$rows.count', '$uploaders')
      }
    }
  ]
};

export const sceneCards: readonly FeatureUsageCard[] = sceneAspects.map(aspect => ({
  name: aspect.name,
  description: `${aspect.description} It counts uploads, as it describes what the slideshow draws from, so a few prolific players weigh on it. The mod records the scene from 2026.5.0 on.`,
  collection: 'screenshots',
  chart: { display: 'row', dimensions: [aspect.column], metric: 'uploadShare', isPercent: true },
  pipeline: () => sceneStages(aspect)
}));

export const timeOfDaySet: FeatureUsageCard = {
  name: 'Time of day set in photo mode',
  description: `Share of the uploads of the last 12 ended weeks whose player set the time of day in photo mode rather than capture the city's own.`,
  collection: 'screenshots',
  chart: { display: 'scalar', dimensions: ['uploadShare'], metric: 'uploadShare', isPercent: true },
  pipeline: () => conditionShareStages([conditionIsTrue('time.isOverridden')])
};

export const upscalerForcedOff: FeatureUsageCard = {
  name: 'Upscaler forced off',
  description: `Share of the uploaders of the last 12 ended weeks whose latest capture ran with an upscaler, DLSS or another, that the mod turned off for the capture. Mods before 2026.8.0 reported DLSS alone.`,
  collection: 'screenshots',
  chart: {
    display: 'scalar',
    dimensions: ['uploaderShare'],
    metric: 'uploaderShare',
    isPercent: true
  },
  pipeline: () =>
    latestCaptureShareStages([
      conditionIsTrue('capture.isDlssForcedOff'),
      conditionIsTrue('capture.isUpscalerForcedOff')
    ])
};

export const dynamicResolutionForcedOff: FeatureUsageCard = {
  name: 'Dynamic resolution forced off',
  description: `Share of the uploaders of the last 12 ended weeks whose latest capture ran with dynamic resolution, which the mod turned off for the capture.`,
  collection: 'screenshots',
  chart: {
    display: 'scalar',
    dimensions: ['uploaderShare'],
    metric: 'uploaderShare',
    isPercent: true
  },
  pipeline: () =>
    latestCaptureShareStages([conditionIsTrue('capture.isDynamicResolutionForcedOff')])
};

/**
 * Rows of `week`, `uploads`, `uploaders`, `firstTimeUploaders`, and `uploadsPerUploader`, the last
 * two ended weeks, for the headline numbers.
 * The first group reads every upload, so a first upload is the first ever.
 */
function weeklyUploadStages(): Prisma.InputJsonObject[] {
  return [
    {
      $group: {
        _id: '$creatorId',
        firstWeek: { $min: weekOf('$createdAt') },
        weeks: {
          $push: { $cond: [isInLastWeeks('$createdAt', 2), weekOf('$createdAt'), '$$REMOVE'] }
        }
      }
    },
    { $unwind: '$weeks' },
    {
      $group: {
        _id: { week: '$weeks', creatorId: '$_id' },
        uploads: { $sum: 1 },
        isFirstWeek: { $max: { $eq: ['$weeks', '$firstWeek'] } }
      }
    },
    {
      $group: {
        _id: '$_id.week',
        uploads: { $sum: '$uploads' },
        uploaders: { $sum: 1 },
        firstTimeUploaders: { $sum: { $cond: ['$isFirstWeek', 1, 0] } }
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        week: '$_id',
        uploads: 1,
        uploaders: 1,
        firstTimeUploaders: 1,
        uploadsPerUploader: ratioExpression('$uploads', '$uploaders')
      }
    }
  ];
}

/**
 * Rows of the aspect's column and `uploadShare`, the aspect's groups in order, then Other, each
 * where some uploads fall in it.
 */
function sceneStages(aspect: SceneAspect): Prisma.InputJsonObject[] {
  const labels = [...aspect.groups.map(group => group.label), 'Other'];

  const groupIndex = {
    $indexOfArray: [aspect.groups.map(group => ({ $in: ['$value', [...group.values]] })), true]
  };

  return [
    ...sceneUploadStages(),
    { $project: { value: dottedField('$renderConditions', aspect.key) } },
    { $match: { value: { $type: 'string' } } },
    {
      $group: {
        // An unlisted value, at -1, falls in Other.
        _id: {
          $let: {
            vars: { index: groupIndex },
            in: { $cond: [{ $eq: ['$$index', -1] }, aspect.groups.length, '$$index'] }
          }
        },
        uploads: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$uploads' },
        groups: { $push: { index: '$_id', uploads: '$uploads' } }
      }
    },
    { $unwind: '$groups' },
    { $sort: { 'groups.index': 1 } },
    {
      $project: {
        _id: 0,
        [aspect.column]: { $arrayElemAt: [labels, '$groups.index'] },
        uploadShare: ratioExpression('$groups.uploads', '$total')
      }
    }
  ];
}

/**
 * Stages yielding one row of `uploadShare`: the uploads of the capture window recording their
 * scene that hold any of the given conditions.
 */
function conditionShareStages(
  conditions: readonly Prisma.InputJsonObject[]
): Prisma.InputJsonObject[] {
  return [
    ...sceneUploadStages(),
    {
      $group: {
        _id: null,
        uploads: { $sum: 1 },
        matching: { $sum: { $cond: [{ $or: [...conditions] }, 1, 0] } }
      }
    },
    { $project: { _id: 0, uploadShare: ratioExpression('$matching', '$uploads') } }
  ];
}

/**
 * Stages keeping the uploads of the capture window whose mod recorded the scene they show.
 */
function sceneUploadStages(): Prisma.InputJsonObject[] {
  return [
    {
      $match: {
        $expr: {
          $and: [
            isInLastWeeks('$createdAt', captureWeeks),
            { $eq: [{ $type: dottedField('$renderConditions', 'light.dayPhase') }, 'string'] }
          ]
        }
      }
    }
  ];
}

/**
 * Stages yielding one row of `uploaderShare`: the uploaders of the capture window whose latest
 * upload recording capture overrides holds any of the given conditions.
 */
function latestCaptureShareStages(
  conditions: readonly Prisma.InputJsonObject[]
): Prisma.InputJsonObject[] {
  return [
    ...sceneUploadStages(),
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$creatorId',
        matches: { $first: { $cond: [{ $or: [...conditions] }, 1, 0] } }
      }
    },
    {
      $group: { _id: null, uploaders: { $sum: 1 }, matching: { $sum: '$matches' } }
    },
    { $project: { _id: 0, uploaderShare: ratioExpression('$matching', '$uploaders') } }
  ];
}

/**
 * The expression of whether a capture condition holds true.
 */
function conditionIsTrue(key: string): Prisma.InputJsonObject {
  return { $eq: [dottedField('$renderConditions', key), true] };
}

/**
 * The expression of the family of a photo mode setting, over a `$$this` of `$objectToArray`: its
 * key without a vector or color channel (`/x`, `/r`), then without the property after the first
 * dot, but for the camera's properties, each a family of its own.
 */
function settingFamily(): Prisma.InputJsonObject {
  return {
    $let: {
      vars: { key: { $arrayElemAt: [{ $split: ['$$this.k', '/'] }, 0] } },
      in: {
        $cond: [
          { $regexMatch: { input: '$$key', regex: '^PhotoModeRenderSystem\\.' } },
          '$$key',
          { $arrayElemAt: [{ $split: ['$$key', '.'] }, 0] }
        ]
      }
    }
  };
}

/**
 * The expression of a family's label in {@link settingFamilies}, or of the family itself.
 */
function familyLabel(family: string): Prisma.InputJsonObject {
  return {
    $let: {
      vars: { index: { $indexOfArray: [Object.keys(settingFamilies), family] } },
      in: {
        $cond: [
          { $eq: ['$$index', -1] },
          family,
          { $arrayElemAt: [Object.values(settingFamilies), '$$index'] }
        ]
      }
    }
  };
}

/**
 * The expression of the Monday starting the {@link periodWeeks}-week period of a date, periods
 * counted back from the week in progress so the last one ends with the last ended week.
 */
function periodExpression(date: string): Prisma.InputJsonObject {
  const weeksBack = {
    $dateDiff: { startDate: weekOf(date), endDate: weekOf('$$NOW'), unit: 'week' }
  };

  return {
    $dateSubtract: {
      startDate: weekOf('$$NOW'),
      unit: 'week',
      amount: {
        $multiply: [{ $ceil: { $divide: [weeksBack, periodWeeks] } }, periodWeeks]
      }
    }
  };
}
