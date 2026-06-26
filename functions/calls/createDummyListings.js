const functions = require("firebase-functions");
const admin = require("firebase-admin");

const { createOrUpdatePublicListing } = require("../listing-review/listingModeration.util");
const { throwAndLogHttpsError } = require("../utils/error.util");

const DEFAULT_CURRENCY = "PHP";
const DEFAULT_REGION = {
  country: "Philippines",
  countryCode: "PH",
  state: "Cebu",
  city: "Cebu City",
};
const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

const DUMMY_LISTING_TEMPLATES = [
  {
    title: "Compact City Car Rental",
    description:
      "Fuel-efficient automatic hatchback for errands, meetings, and quick trips around Cebu.",
    categoryId: "vehicles",
    subcategoryId: "cars",
    listingKind: "vehicle",
    detailSchemaKey: "vehicle",
    location: place("Lahug, Cebu City", 10.3317, 123.9056),
    rates: rate(2200, 12800, 44000),
    securityDeposit: 5000,
    details: vehicleDetails("Toyota", "Wigo", 2022, "automatic", "gasoline", 5, 120, true, false, true),
    images: [
      unsplash("photo-1549317661-bd32c8ce0db2"),
      unsplash("photo-1503376780353-7e6692767b70"),
    ],
    inclusions: ["Clean interior", "Phone holder", "Basic emergency kit"],
    ownerInstructions: "Pickup with valid license and one government ID.",
  },
  {
    title: "Automatic SUV With Delivery",
    description:
      "Comfortable SUV with flexible pickup or delivery for family outings and business trips.",
    categoryId: "vehicles",
    subcategoryId: "cars",
    listingKind: "vehicle",
    detailSchemaKey: "vehicle",
    location: place("Banilad, Cebu City", 10.3465, 123.9132),
    rates: rate(3800, 21500, 76000),
    securityDeposit: 8000,
    details: vehicleDetails("Mitsubishi", "Xpander Cross", 2023, "automatic", "gasoline", 7, 150, true, false, true),
    images: [
      unsplash("photo-1542362567-b07e54358753"),
      unsplash("photo-1519641471654-76ce0107ad1b"),
    ],
    inclusions: ["Dash camera", "USB charger", "Umbrella"],
    ownerInstructions: "Please return with the same fuel level.",
  },
  {
    title: "Family Van for Weekend Trips",
    description:
      "Spacious van for airport transfers, out-of-town errands, and weekend group travel.",
    categoryId: "vehicles",
    subcategoryId: "vans",
    listingKind: "vehicle",
    detailSchemaKey: "vehicle",
    location: place("Mandaue City", 10.3403, 123.9416),
    rates: rate(4500, 26000, 92000),
    securityDeposit: 10000,
    details: vehicleDetails("Nissan", "Urvan", 2021, "manual", "diesel", 12, 180, true, false, false),
    images: [
      unsplash("photo-1511919884226-fd3cad34687c"),
      unsplash("photo-1533473359331-0135ef1b58bf"),
    ],
    inclusions: ["Rear air-conditioning", "First-aid kit", "Phone charger"],
    ownerInstructions: "Driver must be comfortable handling a manual van.",
  },
  {
    title: "Motorcycle for City Errands",
    description:
      "Reliable scooter for short city rides, quick deliveries, and daily errands.",
    categoryId: "vehicles",
    subcategoryId: "motorcycles",
    listingKind: "vehicle",
    detailSchemaKey: "vehicle",
    location: place("Capitol Site, Cebu City", 10.3146, 123.8917),
    rates: rate(650, 3600, 12500),
    securityDeposit: 2500,
    details: vehicleDetails("Honda", "Click", 2022, "automatic", "gasoline", 2, 80, true, true, false),
    images: [
      unsplash("photo-1558981806-ec527fa84c39"),
      unsplash("photo-1558981359-219d6364c9c8"),
    ],
    inclusions: ["Helmet", "Raincoat", "Phone mount"],
    ownerInstructions: "Helmet use is required for every ride.",
  },
  {
    title: "Moving Truck for Small Deliveries",
    description:
      "Closed van truck suited for apartment moves, pop-up supplies, and small business deliveries.",
    categoryId: "vehicles",
    subcategoryId: "trucks",
    listingKind: "vehicle",
    detailSchemaKey: "vehicle",
    location: place("Talisay City", 10.2447, 123.8494),
    rates: rate(5200, 30200, 105000),
    securityDeposit: 12000,
    details: vehicleDetails("Isuzu", "Traviz", 2020, "manual", "diesel", 3, 160, true, false, false),
    images: [
      unsplash("photo-1601584115197-04ecc0da31d7"),
      unsplash("photo-1519003722824-194d4455a60c"),
    ],
    inclusions: ["Tie-down straps", "Moving blankets", "Hand trolley"],
    ownerInstructions: "Cargo must be secured before departure.",
  },
  {
    title: "Cozy Condo Near IT Park",
    description:
      "Fully furnished condo with fast internet, kitchen essentials, and parking access.",
    categoryId: "stay-spaces",
    subcategoryId: "stays",
    listingKind: "stay",
    detailSchemaKey: "stay",
    location: place("Cebu IT Park", 10.3304, 123.9067),
    rates: rate(2800, 17000, 58000),
    securityDeposit: 4000,
    details: stayDetails("condo", 3, 1, 2, 1, [
      "wifi",
      "air-conditioning",
      "hot-water",
      "tv",
      "kitchen",
      "refrigerator",
      "private-bathroom",
      "bidet",
      "towels",
      "bed-sheets",
      "car-parking",
      "elevator",
      "self-check-in",
      "fire-extinguisher",
    ]),
    images: [
      unsplash("photo-1522708323590-d24dbb6b0267"),
      unsplash("photo-1505693416388-ac5ce068fe85"),
    ],
    inclusions: ["Fresh linens", "Basic cookware", "Netflix-ready TV"],
    ownerInstructions: "Quiet hours start at 10 PM.",
  },
  {
    title: "Beachfront Studio Stay",
    description:
      "Relaxed studio by the shore with sea view, balcony seating, and kitchen basics.",
    categoryId: "stay-spaces",
    subcategoryId: "stays",
    listingKind: "stay",
    detailSchemaKey: "stay",
    location: place("Mactan, Lapu-Lapu City", 10.2897, 123.9992),
    rates: rate(3600, 21800, 74000),
    securityDeposit: 5000,
    details: stayDetails("studio", 2, 1, 1, 1, [
      "wifi",
      "air-conditioning",
      "hot-water",
      "kitchen",
      "private-bathroom",
      "towels",
      "bed-sheets",
      "beach-access",
      "sea-view",
      "balcony",
      "fire-extinguisher",
    ]),
    images: [
      unsplash("photo-1499793983690-e29da59ef1c2"),
      unsplash("photo-1507525428034-b723cf961d3e"),
    ],
    inclusions: ["Beach towels", "Cookware", "Welcome drinking water"],
    ownerInstructions: "Rinse off sand before entering the unit.",
  },
  {
    title: "Private Event Studio",
    description:
      "Air-conditioned studio for shoots, workshops, intimate launches, and meetings.",
    categoryId: "stay-spaces",
    subcategoryId: "spaces",
    listingKind: "space",
    detailSchemaKey: "space",
    location: place("Kasambagan, Cebu City", 10.3341, 123.9196),
    rates: rate(4200, 24000, 82000),
    securityDeposit: 5000,
    details: spaceDetails(30, ["photo_shoot", "workshop", "meeting", "small_event"], [
      "wifi",
      "air-conditioning",
      "power-outlets",
      "tables",
      "chairs",
      "projector",
      "restroom",
      "dressing-room",
      "staff-assistance",
    ], true),
    images: [
      unsplash("photo-1519167758481-83f550bb49b3"),
      unsplash("photo-1497366754035-f200968a6e72"),
    ],
    inclusions: ["Tables and chairs", "Projector", "Basic cleaning"],
    ownerInstructions: "Setup time is included within the booking window.",
  },
  {
    title: "Covered Parking Space",
    description:
      "Secure covered parking slot near offices, condos, and major road access.",
    categoryId: "stay-spaces",
    subcategoryId: "parking-spaces",
    listingKind: "space",
    detailSchemaKey: "space",
    location: place("Fuente Osmena, Cebu City", 10.3095, 123.8938),
    rates: rate(350, 2100, 7200),
    securityDeposit: 1000,
    details: spaceDetails(1, ["parking"], ["cctv", "security-guard", "power-outlets"], true),
    images: [
      unsplash("photo-1506521781263-d8422e82f27a"),
      unsplash("photo-1590674899484-d5640e854abe"),
    ],
    inclusions: ["Covered slot", "Security access", "Overnight parking"],
    ownerInstructions: "Only one registered vehicle is allowed per booking.",
  },
  {
    title: "Secure Storage Room",
    description:
      "Clean private storage room for boxes, seasonal items, props, and business supplies.",
    categoryId: "stay-spaces",
    subcategoryId: "storage-spaces",
    listingKind: "space",
    detailSchemaKey: "space",
    location: place("Mabolo, Cebu City", 10.3231, 123.9189),
    rates: rate(900, 5200, 18000),
    securityDeposit: 2500,
    details: spaceDetails(4, ["storage"], [
      "cctv",
      "security-guard",
      "storage-area",
      "loading-area",
      "fire-extinguisher",
    ], true),
    images: [
      unsplash("photo-1553413077-190dd305871c"),
      unsplash("photo-1586528116311-ad8dd3c8310d"),
    ],
    inclusions: ["Shelving", "Loading access", "Monthly pest control"],
    ownerInstructions: "Food, fuel, and hazardous items are not allowed.",
  },
  {
    title: "Garden Venue for Gatherings",
    description:
      "Outdoor garden venue with tables, chairs, restroom access, and event support.",
    categoryId: "stay-spaces",
    subcategoryId: "event-venues",
    listingKind: "space",
    detailSchemaKey: "space",
    location: place("Busay, Cebu City", 10.3733, 123.8809),
    rates: rate(9800, 56000, 190000),
    securityDeposit: 10000,
    details: spaceDetails(80, ["party", "wedding", "corporate_event"], [
      "garden",
      "bbq-grill",
      "tables",
      "chairs",
      "restroom",
      "power-outlets",
      "staff-assistance",
      "first-aid-kit",
    ], true),
    images: [
      unsplash("photo-1464366400600-7168b8af9bc3"),
      unsplash("photo-1519225421980-715cb0215aed"),
    ],
    inclusions: ["Event tables", "Garden lighting", "Venue attendant"],
    ownerInstructions: "Amplified music must end by 9 PM.",
  },
  {
    title: "Canon Mirrorless Camera Kit",
    description:
      "Mirrorless camera kit with standard zoom lens for portraits, travel, and product shoots.",
    categoryId: "electronics",
    subcategoryId: "cameras",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Talamban, Cebu City", 10.3713, 123.9141),
    rates: rate(1400, 8200, 28000),
    securityDeposit: 6000,
    details: genericDetails("Excellent condition", "Canon mirrorless body with lens and charger"),
    images: [
      unsplash("photo-1516035069371-29a1b244cc32"),
      unsplash("photo-1502920917128-1aa500764cbd"),
    ],
    inclusions: ["Camera body", "Kit lens", "Battery", "Charger", "Camera bag"],
    ownerInstructions: "Memory card is not included.",
  },
  {
    title: "Portable PA Speaker System",
    description:
      "Powered speaker set for small events, talks, and acoustic performances.",
    categoryId: "party-events",
    subcategoryId: "sound-lighting",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Guadalupe, Cebu City", 10.3154, 123.8786),
    rates: rate(1800, 10200, 35000),
    securityDeposit: 4000,
    details: genericDetails("Tested before release", "Powered speakers with wired microphones and stands"),
    images: [
      unsplash("photo-1545454675-3531b543be5d"),
      unsplash("photo-1520170350707-b2da59970118"),
    ],
    inclusions: ["Two speakers", "Two microphones", "Speaker stands", "Audio cables"],
    ownerInstructions: "Keep equipment dry and away from direct rain.",
  },
  {
    title: "Cordless Drill Combo Set",
    description:
      "Cordless drill and driver set for furniture assembly, repairs, and light renovation work.",
    categoryId: "tools-equipment",
    subcategoryId: "power-tools",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Pardo, Cebu City", 10.2856, 123.8495),
    rates: rate(550, 3100, 10500),
    securityDeposit: 2500,
    details: genericDetails("Good working condition", "Cordless drill driver set with bits and spare battery"),
    images: [
      unsplash("photo-1504148455328-c376907d081c"),
      unsplash("photo-1586864387967-d02ef85d93e8"),
    ],
    inclusions: ["Drill", "Driver", "Battery pack", "Charger", "Bit set"],
    ownerInstructions: "Return all bits in the case after use.",
  },
  {
    title: "Folding Tables and Chairs",
    description:
      "Event-ready folding table and chair set for birthdays, meetings, and food stalls.",
    categoryId: "party-events",
    subcategoryId: "tables-chairs",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Consolacion", 10.3778, 123.9572),
    rates: rate(950, 5600, 19000),
    securityDeposit: 2000,
    details: genericDetails("Clean and stackable", "Set of folding tables and matching chairs"),
    images: [
      unsplash("photo-1524758631624-e2822e304c36"),
      unsplash("photo-1497366811353-6870744d04b2"),
    ],
    inclusions: ["Four folding tables", "Twenty chairs", "Transport straps"],
    ownerInstructions: "Wipe spills before returning the set.",
  },
  {
    title: "Designer Barong Tagalog",
    description:
      "Formal barong for weddings, graduations, and company ceremonies.",
    categoryId: "fashion",
    subcategoryId: "clothing",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Banawa, Cebu City", 10.3069, 123.8768),
    rates: rate(700, 3900, 13200),
    securityDeposit: 2000,
    details: genericDetails("Freshly dry-cleaned", "Formal barong in medium fit with garment cover"),
    images: [
      unsplash("photo-1507679799987-c73779587ccf"),
      unsplash("photo-1552374196-1ab2a1c593e8"),
    ],
    inclusions: ["Barong", "Garment cover", "Wood hanger"],
    ownerInstructions: "Dry-clean only after use.",
  },
  {
    title: "Mountain Bike Trail Set",
    description:
      "Trail bike setup for city rides, weekend routes, and light mountain trails.",
    categoryId: "outdoor-gears",
    subcategoryId: "bikes-scooters",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Liloan", 10.3992, 123.9995),
    rates: rate(850, 4900, 16800),
    securityDeposit: 3000,
    details: genericDetails("Recently serviced", "Mountain bike with helmet, lock, and repair kit"),
    images: [
      unsplash("photo-1485965120184-e220f721d03e"),
      unsplash("photo-1507035895480-2b3156c31fc8"),
    ],
    inclusions: ["Bike", "Helmet", "Lock", "Mini pump", "Patch kit"],
    ownerInstructions: "Avoid deep mud and report any tire puncture.",
  },
  {
    title: "Camping Tent and Gear Bundle",
    description:
      "Camping bundle with tent, sleeping pads, and basic cooking gear for weekend trips.",
    categoryId: "outdoor-gears",
    subcategoryId: "camping-gear",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Cordova", 10.2521, 123.9494),
    rates: rate(1200, 7000, 24000),
    securityDeposit: 3500,
    details: genericDetails("Cleaned after each rental", "Four-person tent bundle with sleeping and cooking basics"),
    images: [
      unsplash("photo-1504280390367-361c6d9f38f4"),
      unsplash("photo-1504851149312-7a075b496cc7"),
    ],
    inclusions: ["Tent", "Ground sheet", "Sleeping pads", "Lantern", "Cook set"],
    ownerInstructions: "Air-dry the tent before packing if it gets wet.",
  },
  {
    title: "Projector and Screen Package",
    description:
      "Portable projector package for movie nights, presentations, and small events.",
    categoryId: "party-events",
    subcategoryId: "photo-booth-equipment",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Labangon, Cebu City", 10.3007, 123.8782),
    rates: rate(1300, 7600, 26000),
    securityDeposit: 3500,
    details: genericDetails("HD projector", "Projector, tripod screen, HDMI cable, and extension cord"),
    images: [
      unsplash("photo-1572177812156-58036aae439c"),
      unsplash("photo-1516321318423-f06f85e504b3"),
    ],
    inclusions: ["Projector", "Tripod screen", "HDMI cable", "Extension cord"],
    ownerInstructions: "Let the projector cool down before packing.",
  },
  {
    title: "Baby Stroller Travel Set",
    description:
      "Foldable stroller and travel essentials for mall days, airport trips, and family outings.",
    categoryId: "others",
    subcategoryId: "baby-kids",
    listingKind: "generic",
    detailSchemaKey: "generic_asset",
    location: place("Cebu Business Park", 10.3186, 123.9052),
    rates: rate(650, 3700, 12600),
    securityDeposit: 2500,
    details: genericDetails("Sanitized before release", "Compact stroller with rain cover and travel bag"),
    images: [
      unsplash("photo-1596698461142-fff630fec938"),
      unsplash("photo-1546015720-b8b30df5aa27"),
    ],
    inclusions: ["Stroller", "Rain cover", "Travel bag", "Cup holder"],
    ownerInstructions: "Do not check in the stroller without the travel bag.",
  },
];

async function createDummyListings(request) {
  try {
    const db = admin.firestore();
    const ownerId = requireAuthenticatedDummyListingOwnerId(request);
    const ownerSnap = await db.collection("users").doc(ownerId).get();

    if (!ownerSnap.exists) {
      throwAndLogHttpsError("not-found", "The selected listing owner does not exist.");
    }

    const categoriesById = await loadCategoriesById(db, requiredCategoryIds());
    const submissions = buildDummyListingSubmissions({
      ownerId,
      categoriesById,
      createAssetId: () => db.collection("assets").doc().id,
    });
    const review = {
      decision: "debug_seed",
      reasons: ["Created by debug dummy listing seeder."],
    };
    const assetIds = [];

    for (const submission of submissions) {
      const { listingId } = await createOrUpdatePublicListing({
        db,
        bucket: null,
        submission,
        owner: ownerSnap.data() || {},
        review,
      });
      assetIds.push(listingId);
    }

    return {
      created: true,
      count: assetIds.length,
      assetIds,
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    console.error("[createDummyListings] Failed to create dummy listings", error);
    throwAndLogHttpsError("internal", "Unable to create dummy listings.", error.message);
  }
}

function requireAuthenticatedDummyListingOwnerId(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throwAndLogHttpsError("permission-denied", "Sign in before creating dummy listings.");
  }
  return uid;
}

function buildDummyListingSubmissions({ ownerId, categoriesById, createAssetId }) {
  return DUMMY_LISTING_TEMPLATES.map((template) => {
    const parent = getCategory(categoriesById, template.categoryId);
    const subcategory = getCategory(categoriesById, template.subcategoryId);
    const assetId = createAssetId();
    const imageUrls = validateHttpsUrls(template.images, template.title);

    return {
      submissionType: "create",
      assetId,
      ownerId,
      title: template.title,
      description: template.description,
      categoryId: parent.id,
      categoryName: parent.name,
      subcategoryId: subcategory.id,
      subcategoryName: subcategory.name,
      listingKind: subcategory.listingKind || parent.listingKind || template.listingKind,
      detailSchemaKey: subcategory.detailSchemaKey || parent.detailSchemaKey || template.detailSchemaKey,
      details: template.details,
      rates: template.rates,
      securityDeposit: securityDeposit(template.securityDeposit),
      location: template.location,
      images: imageUrls,
      showcase: [imageUrls[0]],
      inclusions: template.inclusions,
      ownerInstructions: template.ownerInstructions,
      blocksEndDate: false,
      status: "Available",
      isDeleted: false,
    };
  });
}

async function loadCategoriesById(db, categoryIds) {
  const categoriesById = new Map();
  await Promise.all(
    categoryIds.map(async (categoryId) => {
      const snap = await db.collection("categories").doc(categoryId).get();
      if (!snap.exists) {
        throwAndLogHttpsError("failed-precondition", `Required category '${categoryId}' is missing.`);
      }
      const data = snap.data() || {};
      if (data.isActive === false) {
        throwAndLogHttpsError("failed-precondition", `Required category '${categoryId}' is inactive.`);
      }
      categoriesById.set(categoryId, { id: categoryId, ...data });
    }),
  );
  return categoriesById;
}

function requiredCategoryIds() {
  return Array.from(
    DUMMY_LISTING_TEMPLATES.reduce((ids, template) => {
      ids.add(template.categoryId);
      ids.add(template.subcategoryId);
      return ids;
    }, new Set()),
  );
}

function getCategory(categoriesById, categoryId) {
  const category = categoriesById instanceof Map ? categoriesById.get(categoryId) : categoriesById[categoryId];
  if (!category) {
    throw new Error(`Required category '${categoryId}' was not loaded.`);
  }
  return category;
}

function validateHttpsUrls(urls, title) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Dummy listing '${title}' must include at least one image.`);
  }
  urls.forEach((url) => {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`Dummy listing '${title}' has a non-HTTPS image URL.`);
    }
  });
  return urls;
}

function rate(daily, weekly, monthly) {
  return {
    currency: DEFAULT_CURRENCY,
    daily,
    weekly,
    monthly,
    annually: monthly ? monthly * 10 : null,
  };
}

function securityDeposit(amount) {
  const normalizedAmount = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
  return {
    enabled: normalizedAmount > 0,
    amount: normalizedAmount,
  };
}

function place(label, lat, lng) {
  return {
    ...DEFAULT_REGION,
    address: label,
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    geohash: geohashFor(lat, lng),
  };
}

function genericDetails(condition, notes) {
  return {
    condition,
    notes,
  };
}

function vehicleDetails(make, model, year, transmission, fuelType, seats, mileageLimitKmPerDay, licenseRequired, helmetIncluded, deliveryAvailable) {
  return {
    make,
    model,
    year,
    transmission,
    fuelType,
    seats,
    mileageLimitKmPerDay,
    licenseRequired,
    helmetIncluded,
    deliveryAvailable,
  };
}

function stayDetails(stayType, maxGuests, bedrooms, beds, bathrooms, amenities) {
  return {
    stayType,
    maxGuests,
    bedrooms,
    beds,
    bathrooms,
    amenities,
    checkInTime: "14:00",
    checkOutTime: "11:00",
    minimumNights: 1,
    petsAllowed: false,
    smokingAllowed: false,
    partiesAllowed: false,
  };
}

function spaceDetails(capacity, allowedUses, amenities, hasParking) {
  return {
    capacity,
    allowedUses,
    amenities,
    hasParking,
    setupTimeMinutes: 60,
    cleanupTimeMinutes: 60,
  };
}

function unsplash(photoId) {
  return `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=1400&q=80`;
}

function geohashFor(latitude, longitude, precision = 9) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";
  const latRange = [-90, 90];
  const lonRange = [-180, 180];

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (longitude >= mid) {
        idx = idx * 2 + 1;
        lonRange[0] = mid;
      } else {
        idx *= 2;
        lonRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (latitude >= mid) {
        idx = idx * 2 + 1;
        latRange[0] = mid;
      } else {
        idx *= 2;
        latRange[1] = mid;
      }
    }

    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += GEOHASH_BASE32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

module.exports = {
  createDummyListings,
  _test: {
    DUMMY_LISTING_TEMPLATES,
    buildDummyListingSubmissions,
    geohashFor,
    requireAuthenticatedDummyListingOwnerId,
    requiredCategoryIds,
  },
};
