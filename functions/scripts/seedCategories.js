const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.applicationDefault() });

const categories = [
  categorySeed("vehicles", "Vehicles", 10, "vehicle"),
  categorySeed("cars", "Cars", 1010, "vehicle", "vehicles"),
  categorySeed("motorcycles", "Motorcycles", 1020, "vehicle", "vehicles"),
  categorySeed("vans", "Vans", 1030, "vehicle", "vehicles"),
  categorySeed("trucks", "Trucks", 1040, "vehicle", "vehicles"),

  categorySeed("stay-spaces", "Stay & Spaces", 20, "generic_asset"),
  categorySeed("stays", "Stays", 2010, "stay", "stay-spaces"),
  categorySeed("spaces", "Spaces", 2020, "space", "stay-spaces"),
  categorySeed("parking-spaces", "Parking Spaces", 2030, "space", "stay-spaces"),
  categorySeed("storage-spaces", "Storage Spaces", 2040, "space", "stay-spaces"),
  categorySeed("event-venues", "Event Venues", 2050, "space", "stay-spaces"),

  categorySeed("electronics", "Electronics", 30, "electronics"),
  categorySeed("cameras", "Cameras", 3010, "electronics", "electronics"),
  categorySeed("phones-tablets", "Phones & Tablets", 3020, "electronics", "electronics"),
  categorySeed("computers-laptops", "Computers & Laptops", 3030, "electronics", "electronics"),
  categorySeed("audio-equipment", "Audio Equipment", 3040, "electronics", "electronics"),
  categorySeed("gaming-consoles", "Gaming Consoles", 3050, "electronics", "electronics"),
  categorySeed("drones", "Drones", 3060, "electronics", "electronics"),

  categorySeed("outdoor-gears", "Outdoor Gears", 40, "generic_asset"),
  categorySeed("camping-gear", "Camping Gear", 4010, "generic_asset", "outdoor-gears"),
  categorySeed("hiking-gear", "Hiking Gear", 4020, "generic_asset", "outdoor-gears"),
  categorySeed("sports-equipment", "Sports Equipment", 4030, "generic_asset", "outdoor-gears"),
  categorySeed("bikes-scooters", "Bikes & Scooters", 4040, "generic_asset", "outdoor-gears"),
  categorySeed("water-sports", "Water Sports", 4050, "generic_asset", "outdoor-gears"),

  categorySeed("hobbies", "Hobbies", 50, "generic_asset"),
  categorySeed("musical-instruments", "Musical Instruments", 5010, "generic_asset", "hobbies"),
  categorySeed("arts-crafts", "Arts & Crafts", 5020, "generic_asset", "hobbies"),
  categorySeed("board-games", "Board Games", 5030, "generic_asset", "hobbies"),
  categorySeed("collectibles", "Collectibles", 5040, "generic_asset", "hobbies"),
  categorySeed("fitness-gear", "Fitness Gear", 5050, "generic_asset", "hobbies"),

  categorySeed("tools-equipment", "Tools & Equipment", 60, "tool"),
  categorySeed("power-tools", "Power Tools", 6010, "tool", "tools-equipment"),
  categorySeed("hand-tools", "Hand Tools", 6020, "tool", "tools-equipment"),
  categorySeed("garden-tools", "Garden Tools", 6030, "tool", "tools-equipment"),
  categorySeed("ladders", "Ladders", 6040, "tool", "tools-equipment"),
  categorySeed("cleaning-equipment", "Cleaning Equipment", 6050, "tool", "tools-equipment"),

  categorySeed("fashion", "Fashion", 70, "clothing"),
  categorySeed("clothing", "Clothing", 7010, "clothing", "fashion"),
  categorySeed("shoes", "Shoes", 7020, "clothing", "fashion"),
  categorySeed("bags-accessories", "Bags & Accessories", 7030, "generic_asset", "fashion"),
  categorySeed("jewelry-accessories", "Jewelry & Accessories", 7040, "generic_asset", "fashion"),

  categorySeed("party-events", "Party & Events", 80, "party_event"),
  categorySeed("party-supplies", "Party Supplies", 8010, "party_event", "party-events"),
  categorySeed("tables-chairs", "Tables & Chairs", 8020, "party_event", "party-events"),
  categorySeed("sound-lighting", "Sound & Lighting", 8030, "party_event", "party-events"),
  categorySeed("photo-booth-equipment", "Photo Booth Equipment", 8040, "party_event", "party-events"),
  categorySeed("costumes", "Costumes", 8050, "clothing", "party-events"),

  categorySeed("books-learning", "Books & Learning", 90, "generic_asset"),
  categorySeed("books", "Books", 9010, "generic_asset", "books-learning"),
  categorySeed("textbooks", "Textbooks", 9020, "generic_asset", "books-learning"),
  categorySeed("learning-materials", "Learning Materials", 9030, "generic_asset", "books-learning"),
  categorySeed("school-supplies", "School Supplies", 9040, "generic_asset", "books-learning"),

  categorySeed("others", "Others", 100, "generic_asset"),
  categorySeed("home-appliances", "Home Appliances", 10010, "generic_asset", "others"),
  categorySeed("baby-kids", "Baby & Kids", 10020, "generic_asset", "others"),
  categorySeed("pet-supplies", "Pet Supplies", 10030, "generic_asset", "others"),
  categorySeed("miscellaneous", "Miscellaneous", 10040, "generic_asset", "others"),
];

async function main() {
  const db = admin.firestore();
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const category of categories) {
    batch.set(
      db.collection("categories").doc(category.slug),
      {
        name: category.name,
        slug: category.slug,
        iconKey: category.slug,
        imageUrl: null,
        sortOrder: category.sortOrder,
        isActive: true,
        isFeatured: false,
        listingKind: category.schemaKey,
        detailSchemaKey: category.schemaKey,
        parentId: category.parentId,
        level: category.parentId ? 2 : 1,
        createdAt: now,
        updatedAt: now,
        createdBy: "seed",
        updatedBy: "seed",
      },
      { merge: true },
    );
  }

  await batch.commit();
  console.log(`Seeded ${categories.length} categories.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());

function categorySeed(slug, name, sortOrder, schemaKey, parentId = null) {
  return {
    name,
    parentId,
    schemaKey,
    slug,
    sortOrder,
  };
}
