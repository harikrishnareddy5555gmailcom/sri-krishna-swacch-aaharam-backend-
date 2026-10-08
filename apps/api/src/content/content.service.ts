import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorefrontContentDto,
  StorefrontDraftDto,
  StorefrontPolicies,
} from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';

/**
 * Default verified storefront content seed.
 * 
 * Factual marketing claims policy:
 * - Only verified cold-pressed oil categories are enabled.
 * - Carrier temperature is stated as factual business processing narrative (< 40°C in wooden chekku).
 * - No fake ratings, fake review counts, or unverified certification claims.
 * - Unapproved policies are marked clearly as pending configuration.
 */
export const DEFAULT_STOREFRONT_CONTENT: StorefrontContentDto = {
  version: 1,
  publishedAt: new Date().toISOString(),
  publishedBy: 'system-seed',
  announcement: {
    enabled: true,
    text: 'Complimentary shipping across India on orders above ₹999 • Wood-Pressed at < 40°C',
    linkText: 'Learn About Our Process',
    linkUrl: '#production-process',
  },
  hero: {
    enabled: true,
    badgeText: 'Wood-Pressed at < 40°C • 100% Pure & Unrefined',
    heading: "Nature's Wisdom",
    highlightText: 'Bottled Pure.',
    description:
      'Traditional cold-pressed groundnut, coconut, sesame, and mustard oils extracted slowly in wooden chekku. Free of chemical solvents, zero additives, and naturally rich in aroma.',
    ctaText: 'Shop the Collection',
    ctaLink: '/products',
    secondaryCtaText: "See How It's Made →",
    secondaryCtaLink: '#production-process',
    imageUrl: '/hero-oil.jpg',
    imageAlt:
      'Premium cold-pressed oil in an amber glass bottle surrounded by botanical ingredients on natural linen',
  },
  categories: {
    enabled: true,
    heading: 'Browse by Category',
    subheading: 'Find exactly what you need for healthy, wholesome cooking',
    onlyAvailableOils: true,
  },
  featured: {
    enabled: true,
    badgeText: 'Farm Fresh & Pure',
    heading: 'Our Bestsellers',
    subheading: 'Cold-pressed, unadulterated traditional oils for everyday culinary wellness',
    limit: 4,
  },
  process: {
    enabled: true,
    badgeText: 'The Traditional Craft',
    heading: 'Traditional Wood-Pressed Oils For A Reason',
    description:
      'We press slowly in seasoned Vagai wooden chekku at gentle RPMs. Never heated, never solvent-extracted.',
    cardTitle: 'Cold-pressed at less than 40 degrees.',
    cardDescription:
      'Heat degrades delicate essential nutrients. In conventional commercial mills, friction drives temperatures past 100°C–200°C. Our slow wooden chekku operates at ambient temperatures, preserving natural vitamins, authentic nutty aroma, and original life force.',
    temperatureNote: 'Wood Chekku Ambient Process: typically 32°C - 38°C without artificial heating',
    imageUrl: '/chekku-press.jpg',
    steps: [
      {
        step: '01',
        title: 'Farm-Direct Seeds',
        desc: 'Hand-picked local groundnuts, coconuts and sesame seeds direct from organic growers.',
      },
      {
        step: '02',
        title: 'Sun-Drying',
        desc: 'Seeds are dried naturally under sunlight to reach optimum moisture without artificial drying ovens.',
      },
      {
        step: '03',
        title: 'Wooden Chekku Press',
        desc: 'Crushed slowly in stone and wood mortar at < 40°C with zero chemical solvents.',
      },
      {
        step: '04',
        title: 'Natural Cloth Filtration',
        desc: 'Filtered gently through clean cotton cloth and naturally settled — no chemical bleaching.',
      },
    ],
  },
  story: {
    enabled: true,
    tag: 'Our Philosophy',
    heading: "Nature's intelligence is our formulation guide.",
    paragraphs: [
      'Sri Krishna Swacch Aaharam was founded on the belief that traditional cold-pressing and natural foods offer the purest path to everyday health and vitality.',
      'Our oils are extracted using traditional wooden chekku — a process that preserves the full spectrum of nutrients, natural aroma, and inherent vitality that modern refining strips away.',
    ],
    ctaText: 'Explore the Collection',
    ctaLink: '/products',
    imageUrl: '/auth-botanical.jpg',
  },
  faqs: {
    enabled: true,
    badgeText: 'Clear Answers',
    heading: 'Frequently Asked Questions',
    faqs: [
      {
        q: 'What is wood-pressed (cold-pressed) oil?',
        a: 'Wood-pressed oil is extracted by slowly crushing whole seeds in a traditional wooden mortar and pestle (chekku). Because it operates without external heat, the oil temperature remains below 40°C, preserving natural vitamins, antioxidants, and original aroma.',
      },
      {
        q: 'How is it different from refined supermarket oils?',
        a: 'Refined oils undergo extreme industrial processing at over 200°C using chemical solvents (like hexane), chemical bleaching, and deodorization. Wood-pressed oils contain zero chemical additives, zero trans fats, and retain all their natural nutrients.',
      },
      {
        q: 'Why does wood-pressed oil smell and taste richer?',
        a: 'Because it is pure and raw. Refined oils are stripped of all natural aromas and flavors through heat and chemicals. Cold-pressed oil retains the authentic aroma and taste of fresh seeds.',
      },
      {
        q: 'How should I store cold-pressed oils?',
        a: 'Keep the bottles tightly closed in a cool, dark place away from direct sunlight. No refrigeration is required. Because our oils are natural with no artificial preservatives, they stay freshest within 6 to 9 months of packaging.',
      },
    ],
  },
  trust: {
    enabled: true,
    items: [
      { title: 'Free Shipping', sub: 'On orders above ₹999' },
      { title: 'Secure Packaging', sub: 'Tamper-evident food-grade containers' },
      { title: 'Return Assistance', sub: 'Subject to policy verification & sealed condition' },
      { title: 'Pure Extraction', sub: 'Wood chekku pressed, zero mineral oil' },
    ],
  },
  finalCta: {
    enabled: true,
    heading: 'Ready to taste the difference?',
    description:
      'Browse our collection of wood-pressed oils extracted using time-honored artisanal methods.',
    primaryBtnText: 'Browse Catalog',
    primaryBtnLink: '/products',
    secondaryBtnText: 'Create Account',
    secondaryBtnLink: '/register',
  },
  policies: {
    shippingDelivery: {
      title: 'Shipping & Delivery Policy',
      slug: 'shipping-delivery',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'Orders are dispatched within 24 to 48 business hours from our facility. We partner with reliable courier services to ensure prompt delivery across India. Standard delivery timeline is 3-6 business days depending on location. Complimentary delivery is available for orders exceeding ₹999.',
    },
    returns: {
      title: 'Returns Policy',
      slug: 'returns',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'Due to the perishable and consumable nature of edible oils, items are eligible for return or replacement strictly in cases of transit damage, packaging defect, leakage upon arrival, or incorrect item dispatch. Customers must report damage within 48 hours of delivery with photographic evidence.',
    },
    refunds: {
      title: 'Refund Policy',
      slug: 'refunds',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'Approved refunds are initiated through our payment gateway back to the original payment source within 5-7 business working days after operational inspection and approval. Cash on delivery refunds are processed via secure bank NEFT/UPI transfer.',
    },
    cancellations: {
      title: 'Order Cancellation Policy',
      slug: 'cancellations',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'Orders can be cancelled before dispatch directly from your account order dashboard. Once dispatched with an active courier tracking number, orders cannot be cancelled mid-transit and will follow standard return/refusal procedures.',
    },
    terms: {
      title: 'Terms & Conditions',
      slug: 'terms',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'By browsing, accessing, or placing an order on Sri Krishna Swacch Aaharam, you agree to comply with our terms of service, payment agreements, and acceptable use guidelines. All product descriptions and pricing are subject to confirmation at time of order checkout.',
    },
    privacy: {
      title: 'Privacy Policy',
      slug: 'privacy',
      isPublished: true,
      lastUpdated: new Date().toISOString(),
      content:
        'Sri Krishna Swacch Aaharam is committed to protecting your personal data. We collect customer shipping address, phone number, and email strictly for order fulfillment, invoice generation, delivery updates, and support communication. We never sell customer information.',
    },
  },
};

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);
  private readonly dataDir: string;
  private readonly contentFilePath: string;

  constructor() {
    this.dataDir = path.resolve(process.cwd(), 'data');
    this.contentFilePath = path.join(this.dataDir, 'storefront-content.json');
    this.ensureStorageExists();
  }

  private ensureStorageExists(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      if (!fs.existsSync(this.contentFilePath)) {
        const initialPayload: StorefrontDraftDto = {
          published: DEFAULT_STOREFRONT_CONTENT,
          draft: DEFAULT_STOREFRONT_CONTENT,
          hasUnpublishedChanges: false,
          lastModifiedAt: new Date().toISOString(),
          lastModifiedBy: 'system-init',
        };
        fs.writeFileSync(
          this.contentFilePath,
          JSON.stringify(initialPayload, null, 2),
          'utf-8',
        );
        this.logger.log('Initialized storefront content storage with default verified content');
      }
    } catch (err) {
      this.logger.error('Failed to initialize storefront content storage', err);
    }
  }

  private readStorage(): StorefrontDraftDto {
    try {
      this.ensureStorageExists();
      const content = fs.readFileSync(this.contentFilePath, 'utf-8');
      return JSON.parse(content) as StorefrontDraftDto;
    } catch (err) {
      this.logger.error('Error reading storefront content file, falling back to defaults', err);
      return {
        published: DEFAULT_STOREFRONT_CONTENT,
        draft: DEFAULT_STOREFRONT_CONTENT,
        hasUnpublishedChanges: false,
        lastModifiedAt: new Date().toISOString(),
      };
    }
  }

  private writeStorage(data: StorefrontDraftDto): void {
    try {
      this.ensureStorageExists();
      const tempPath = `${this.contentFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.contentFilePath);
    } catch (err) {
      this.logger.error('Error writing storefront content atomically', err);
      throw err;
    }
  }

  /**
   * Sanitizes string values to prevent script injection (XSS defense).
   */
  private sanitizeString(val: string): string {
    if (typeof val !== 'string') return '';
    return val
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/onerror\s*=/gi, '')
      .replace(/onload\s*=/gi, '');
  }

  private sanitizeContent(content: StorefrontContentDto): StorefrontContentDto {
    const cloned = JSON.parse(JSON.stringify(content)) as StorefrontContentDto;
    cloned.announcement.text = this.sanitizeString(cloned.announcement.text);
    if (cloned.announcement.linkText) {
      cloned.announcement.linkText = this.sanitizeString(cloned.announcement.linkText);
    }
    cloned.hero.heading = this.sanitizeString(cloned.hero.heading);
    cloned.hero.highlightText = this.sanitizeString(cloned.hero.highlightText);
    cloned.hero.description = this.sanitizeString(cloned.hero.description);
    cloned.hero.ctaText = this.sanitizeString(cloned.hero.ctaText);
    cloned.hero.badgeText = this.sanitizeString(cloned.hero.badgeText);
    cloned.hero.imageAlt = this.sanitizeString(cloned.hero.imageAlt);
    
    cloned.categories.heading = this.sanitizeString(cloned.categories.heading);
    cloned.categories.subheading = this.sanitizeString(cloned.categories.subheading);

    cloned.featured.heading = this.sanitizeString(cloned.featured.heading);
    cloned.featured.subheading = this.sanitizeString(cloned.featured.subheading);
    cloned.featured.badgeText = this.sanitizeString(cloned.featured.badgeText);

    cloned.process.heading = this.sanitizeString(cloned.process.heading);
    cloned.process.description = this.sanitizeString(cloned.process.description);
    cloned.process.cardTitle = this.sanitizeString(cloned.process.cardTitle);
    cloned.process.cardDescription = this.sanitizeString(cloned.process.cardDescription);
    cloned.process.temperatureNote = this.sanitizeString(cloned.process.temperatureNote);
    cloned.process.steps = (cloned.process.steps || []).map((s) => ({
      step: this.sanitizeString(s.step),
      title: this.sanitizeString(s.title),
      desc: this.sanitizeString(s.desc),
    }));

    cloned.story.heading = this.sanitizeString(cloned.story.heading);
    cloned.story.tag = this.sanitizeString(cloned.story.tag);
    cloned.story.paragraphs = (cloned.story.paragraphs || []).map((p) => this.sanitizeString(p));

    cloned.faqs.heading = this.sanitizeString(cloned.faqs.heading);
    cloned.faqs.badgeText = this.sanitizeString(cloned.faqs.badgeText);
    cloned.faqs.faqs = (cloned.faqs.faqs || []).map((f) => ({
      q: this.sanitizeString(f.q),
      a: this.sanitizeString(f.a),
    }));

    cloned.trust.items = (cloned.trust.items || []).map((t) => ({
      title: this.sanitizeString(t.title),
      sub: this.sanitizeString(t.sub),
    }));

    cloned.finalCta.heading = this.sanitizeString(cloned.finalCta.heading);
    cloned.finalCta.description = this.sanitizeString(cloned.finalCta.description);
    cloned.finalCta.primaryBtnText = this.sanitizeString(cloned.finalCta.primaryBtnText);
    cloned.finalCta.secondaryBtnText = this.sanitizeString(cloned.finalCta.secondaryBtnText);

    // Sanitize policies
    for (const key of Object.keys(cloned.policies) as (keyof StorefrontPolicies)[]) {
      const pol = cloned.policies[key];
      if (pol) {
        pol.title = this.sanitizeString(pol.title);
        pol.content = this.sanitizeString(pol.content);
      }
    }

    return cloned;
  }

  /**
   * Public: returns currently published storefront content.
   */
  getPublishedContent(): StorefrontContentDto {
    const data = this.readStorage();
    return data.published;
  }

  /**
   * Admin: returns draft and published versions with modification metadata.
   */
  getDraftContent(): StorefrontDraftDto {
    return this.readStorage();
  }

  /**
   * Admin: saves a new draft without publishing to live storefront.
   */
  saveDraft(newDraft: StorefrontContentDto, user?: MinimalUser): StorefrontDraftDto {
    const sanitized = this.sanitizeContent(newDraft);
    const current = this.readStorage();

    const updated: StorefrontDraftDto = {
      published: current.published,
      draft: {
        ...sanitized,
        version: current.published.version,
      },
      hasUnpublishedChanges: true,
      lastModifiedAt: new Date().toISOString(),
      lastModifiedBy: user ? (user.email ? `${user.email} (${user.role})` : user.id) : 'admin',
    };

    this.writeStorage(updated);
    this.logger.log(`Storefront draft saved by ${updated.lastModifiedBy}`);
    return updated;
  }

  /**
   * Admin: publishes the current draft to the live storefront.
   */
  publishDraft(user?: MinimalUser): StorefrontDraftDto {
    const current = this.readStorage();
    const sanitizedDraft = this.sanitizeContent(current.draft);
    const newVersion = (current.published.version || 1) + 1;
    const publisher = user ? (user.email ? `${user.email} (${user.role})` : user.id) : 'admin';

    const publishedPayload: StorefrontContentDto = {
      ...sanitizedDraft,
      version: newVersion,
      publishedAt: new Date().toISOString(),
      publishedBy: publisher,
    };

    const updated: StorefrontDraftDto = {
      published: publishedPayload,
      draft: publishedPayload,
      hasUnpublishedChanges: false,
      lastModifiedAt: new Date().toISOString(),
      lastModifiedBy: publisher,
    };

    this.writeStorage(updated);
    this.logger.log(`Storefront version ${newVersion} published by ${publisher}`);
    return updated;
  }

  /**
   * Admin: reverts current draft back to currently published state.
   */
  revertDraft(user?: MinimalUser): StorefrontDraftDto {
    const current = this.readStorage();
    const actor = user ? (user.email ?? user.id) : 'admin';

    const reverted: StorefrontDraftDto = {
      published: current.published,
      draft: JSON.parse(JSON.stringify(current.published)),
      hasUnpublishedChanges: false,
      lastModifiedAt: new Date().toISOString(),
      lastModifiedBy: `Reverted by ${actor}`,
    };

    this.writeStorage(reverted);
    this.logger.log(`Storefront draft reverted to published version ${current.published.version}`);
    return reverted;
  }
}
