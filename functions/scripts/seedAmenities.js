const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.applicationDefault() });

const amenities = [
  amenitySeed("wifi", "Wi-Fi", "Comfort", 10, ["stay", "space", "party_event"]),
  amenitySeed("air-conditioning", "Air Conditioning", "Comfort", 20, ["stay", "space", "party_event"]),
  amenitySeed("electric-fan", "Electric Fan", "Comfort", 30, ["stay", "space", "party_event"]),
  amenitySeed("hot-water", "Hot Water", "Comfort", 40, ["stay"]),
  amenitySeed("tv", "TV", "Comfort", 50, ["stay", "space"]),

  amenitySeed("kitchen", "Kitchen", "Kitchen", 110, ["stay", "space"]),
  amenitySeed("refrigerator", "Refrigerator", "Kitchen", 120, ["stay", "space"]),
  amenitySeed("microwave", "Microwave", "Kitchen", 130, ["stay", "space"]),
  amenitySeed("rice-cooker", "Rice Cooker", "Kitchen", 140, ["stay"]),
  amenitySeed("electric-kettle", "Electric Kettle", "Kitchen", 150, ["stay", "space"]),
  amenitySeed("water-dispenser", "Water Dispenser", "Kitchen", 160, ["stay", "space", "party_event"]),
  amenitySeed("cookware", "Cookware", "Kitchen", 170, ["stay"]),
  amenitySeed("dining-table", "Dining Table", "Kitchen", 180, ["stay", "space", "party_event"]),

  amenitySeed("private-bathroom", "Private Bathroom", "Bathroom", 210, ["stay", "space"]),
  amenitySeed("bidet", "Bidet", "Bathroom", 220, ["stay", "space"]),
  amenitySeed("towels", "Towels", "Bathroom", 230, ["stay"]),
  amenitySeed("bed-sheets", "Bed Sheets", "Bathroom", 240, ["stay"]),
  amenitySeed("washing-machine", "Washing Machine", "Bathroom", 250, ["stay", "space"]),
  amenitySeed("iron", "Iron", "Bathroom", 260, ["stay", "space"]),

  amenitySeed("car-parking", "Car Parking", "Parking & Access", 310, ["stay", "space", "party_event"]),
  amenitySeed("motorcycle-parking", "Motorcycle Parking", "Parking & Access", 320, ["stay", "space", "party_event"]),
  amenitySeed("elevator", "Elevator", "Parking & Access", 330, ["stay", "space", "party_event"]),
  amenitySeed("private-entrance", "Private Entrance", "Parking & Access", 340, ["stay", "space", "party_event"]),
  amenitySeed("self-check-in", "Self Check-in", "Parking & Access", 350, ["stay", "space"]),

  amenitySeed("pool", "Pool", "Outdoor", 410, ["stay", "space"]),
  amenitySeed("balcony", "Balcony", "Outdoor", 420, ["stay", "space"]),
  amenitySeed("garden", "Garden", "Outdoor", 430, ["stay", "space", "party_event"]),
  amenitySeed("bbq-grill", "BBQ Grill", "Outdoor", 440, ["stay", "space", "party_event"]),
  amenitySeed("beach-access", "Beach Access", "Outdoor", 450, ["stay", "space"]),
  amenitySeed("sea-view", "Sea View", "Outdoor", 460, ["stay", "space"]),
  amenitySeed("mountain-view", "Mountain View", "Outdoor", 470, ["stay", "space"]),

  amenitySeed("fire-extinguisher", "Fire Extinguisher", "Safety", 510, ["stay", "space", "party_event"]),
  amenitySeed("first-aid-kit", "First Aid Kit", "Safety", 520, ["stay", "space", "party_event"]),
  amenitySeed("cctv", "CCTV", "Safety", 530, ["stay", "space", "party_event"]),
  amenitySeed("security-guard", "Security Guard", "Safety", 540, ["stay", "space", "party_event"]),
  amenitySeed("generator", "Generator", "Safety", 550, ["stay", "space", "party_event"]),
  amenitySeed("water-tank", "Water Tank", "Safety", 560, ["stay", "space", "party_event"]),
  amenitySeed("power-outlets", "Power Outlets", "Safety", 570, ["space", "party_event"]),

  amenitySeed("tables", "Tables", "Event Equipment", 610, ["space", "party_event"]),
  amenitySeed("chairs", "Chairs", "Event Equipment", 620, ["space", "party_event"]),
  amenitySeed("sound-system", "Sound System", "Event Equipment", 630, ["party_event"]),
  amenitySeed("microphones", "Microphones", "Event Equipment", 640, ["party_event"]),
  amenitySeed("projector", "Projector", "Event Equipment", 650, ["space", "party_event"]),
  amenitySeed("lighting-equipment", "Lighting Equipment", "Event Equipment", 660, ["party_event"]),
  amenitySeed("extension-cords", "Extension Cords", "Event Equipment", 670, ["space", "party_event"]),
  amenitySeed("restroom", "Restroom", "Event Equipment", 680, ["space", "party_event"]),
  amenitySeed("dressing-room", "Dressing Room", "Event Equipment", 690, ["space", "party_event"]),

  amenitySeed("storage-area", "Storage Area", "Venue Support", 710, ["space", "party_event"]),
  amenitySeed("loading-area", "Loading Area", "Venue Support", 720, ["space", "party_event"]),
  amenitySeed("cleaning-available", "Cleaning Available", "Venue Support", 730, ["stay", "space", "party_event"]),
  amenitySeed("staff-assistance", "Staff Assistance", "Venue Support", 740, ["space", "party_event"]),
];

async function main() {
  const db = admin.firestore();
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const amenity of amenities) {
    batch.set(
      db.collection("amenities").doc(amenity.id),
      {
        label: amenity.label,
        iconKey: amenity.id,
        group: amenity.group,
        sortOrder: amenity.sortOrder,
        isActive: true,
        appliesToDetailSchemaKeys: amenity.appliesToDetailSchemaKeys,
        createdAt: now,
        updatedAt: now,
        createdBy: "seed",
        updatedBy: "seed",
      },
      { merge: true },
    );
  }

  await batch.commit();
  console.log(`Seeded ${amenities.length} amenities.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());

function amenitySeed(id, label, group, sortOrder, appliesToDetailSchemaKeys) {
  return {
    appliesToDetailSchemaKeys,
    group,
    id,
    label,
    sortOrder,
  };
}
