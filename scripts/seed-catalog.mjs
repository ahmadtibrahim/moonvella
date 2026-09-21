import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CATALOG = [
  {
    name: "Hotel Pillow",
    sku: "MV-HP-001",
    category: "Pillows",
    description:
      "Premium hotel-quality support pillow with hypoallergenic fill. A proven bestseller for bedding retailers.",
    wholesale: 1299,
    retail: 4900,
    variants: [
      { name: "Standard", inventory: 640, weight: 900 },
      { name: "King", inventory: 605, weight: 1100 },
    ],
  },
  {
    name: "Cooling Pillow",
    sku: "MV-CP-001",
    category: "Pillows",
    description:
      "Phase-change cooling gel pillow with breathable cover for hot sleepers.",
    wholesale: 1899,
    retail: 6900,
    variants: [
      { name: "Standard", inventory: 260, weight: 950 },
      { name: "King", inventory: 220, weight: 1150 },
    ],
  },
  {
    name: "All-Season Duvet",
    sku: "MV-DUV-001",
    category: "Duvets",
    description:
      "Mid-weight all-season duvet with box-stitched construction and corner loops.",
    wholesale: 5899,
    retail: 19900,
    variants: [
      { name: "Queen", inventory: 340, weight: 2200 },
      { name: "King", inventory: 292, weight: 2600 },
    ],
  },
  {
    name: "Premium Duvet",
    sku: "MV-PD-001",
    category: "Duvets",
    description:
      "Luxury 300-thread-count sateen duvet with box stitch and piped edges.",
    wholesale: 7900,
    retail: 24900,
    variants: [
      { name: "Queen", inventory: 170, weight: 2400 },
      { name: "King", inventory: 150, weight: 2800 },
    ],
  },
  {
    name: "Waterproof Mattress Protector",
    sku: "MV-MP-001",
    category: "Mattress Protectors",
    description:
      "Quiet waterproof mattress protector with deep elastic skirt and breathable membrane.",
    wholesale: 2200,
    retail: 7900,
    variants: [
      { name: "Queen", inventory: 470, weight: 900 },
      { name: "King", inventory: 421, weight: 1050 },
    ],
  },
  {
    name: "Pillow Protector Set",
    sku: "MV-PPS-001",
    category: "Pillow Protectors",
    description:
      "Zippered pillow protector set, dust-mite resistant with quiet soft-touch fabric.",
    wholesale: 1999,
    retail: 6900,
    variants: [
      { name: "Standard (2-pack)", inventory: 400, weight: 600 },
      { name: "King (2-pack)", inventory: 360, weight: 720 },
    ],
  },
  {
    name: "Complete Bedding Bundle",
    sku: "MV-BND-001",
    category: "Bundles",
    description:
      "Best-value bundle: premium duvet, two hotel pillows and a waterproof protector.",
    wholesale: 12900,
    retail: 39900,
    variants: [
      { name: "Queen Bundle", inventory: 120, weight: 5200 },
      { name: "King Bundle", inventory: 90, weight: 6100 },
    ],
  },
];

async function main() {
  for (const product of CATALOG) {
    // The family carries the name and the code. Prices, weight and stock are
    // properties of a sellable variant and are written below, not here: a
    // product-level price is what a multi-size family cannot express.
    const record = await prisma.product.upsert({
      where: { productCode: product.sku },
      create: {
        name: product.name,
        productCode: product.sku,
        category: product.category,
        description: product.description,
        isActive: true,
        isArchived: false,
      },
      update: {
        name: product.name,
        category: product.category,
        description: product.description,
        isActive: true,
        isArchived: false,
      },
    });

    for (const [index, variant] of product.variants.entries()) {
      const variantSku = `${product.sku}-${variant.name
        .replace(/[^A-Za-z0-9]+/g, "")
        .toUpperCase()
        .slice(0, 8)}`;
      // Seed data states weight in grams, which is how a supplier quotes it.
      // The canonical column is kilograms, so the conversion happens here and
      // the stored value is what everything downstream reads.
      const weightKg = (variant.weight / 1000).toFixed(3);
      await prisma.productVariant.upsert({
        where: { sku: variantSku },
        create: {
          productId: record.id,
          sku: variantSku,
          name: variant.name,
          wholesalePrice: product.wholesale,
          suggestedRetailPrice: product.retail,
          costPrice: Math.round(product.wholesale * 0.6),
          inventory: variant.inventory,
          productWeightKg: weightKg,
          sortOrder: index,
          // The first variant is the one a single-variant family sells as, and
          // the one the catalogue shows first.
          isDefault: index === 0,
          isActive: true,
        },
        update: {
          productId: record.id,
          name: variant.name,
          wholesalePrice: product.wholesale,
          suggestedRetailPrice: product.retail,
          inventory: variant.inventory,
          productWeightKg: weightKg,
          sortOrder: index,
          isActive: true,
        },
      });
    }

    console.log(`Seeded ${product.name} (${product.variants.length} variants)`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
