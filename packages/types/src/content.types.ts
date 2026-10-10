/**
 * Storefront Content Management Types (Phase 20D.3)
 *
 * Provider-independent typed content schema for editable homepage sections,
 * announcements, FAQ entries, media references, and customer-facing policies.
 */

export interface AnnouncementContent {
  enabled: boolean;
  text: string;
  linkText?: string;
  linkUrl?: string;
}

export interface HeroContent {
  enabled: boolean;
  badgeText: string;
  heading: string;
  highlightText: string;
  description: string;
  ctaText: string;
  ctaLink: string;
  secondaryCtaText: string;
  secondaryCtaLink: string;
  imageUrl: string;
  imageAlt: string;
}

export interface CategoryCardContent {
  id: string;
  name: string;
  teluguName?: string;
  slug: string;
  badge?: string;
  description?: string;
  imageUrl?: string;
  iconSrc?: string;
  themeGradient?: string;
  accentColor?: string;
  badgeBg?: string;
}

export interface CategorySectionContent {
  enabled: boolean;
  heading: string;
  subheading: string;
  onlyAvailableOils: boolean;
  items?: CategoryCardContent[];
}

export interface FeaturedSectionContent {
  enabled: boolean;
  badgeText: string;
  heading: string;
  subheading: string;
  limit: number;
}

export interface ProcessStep {
  step: string;
  title: string;
  desc: string;
}

export interface ProcessSectionContent {
  enabled: boolean;
  badgeText: string;
  heading: string;
  description: string;
  cardTitle: string;
  cardDescription: string;
  temperatureNote: string;
  imageUrl?: string;
  steps: ProcessStep[];
}

export interface StorySectionContent {
  enabled: boolean;
  tag: string;
  heading: string;
  paragraphs: string[];
  ctaText: string;
  ctaLink: string;
  imageUrl: string;
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface FaqSectionContent {
  enabled: boolean;
  badgeText: string;
  heading: string;
  faqs: FaqItem[];
}

export interface TrustItem {
  title: string;
  sub: string;
}

export interface TrustSectionContent {
  enabled: boolean;
  items: TrustItem[];
}

export interface FinalCtaContent {
  enabled: boolean;
  heading: string;
  description: string;
  primaryBtnText: string;
  primaryBtnLink: string;
  secondaryBtnText: string;
  secondaryBtnLink: string;
}

export interface PolicyDocument {
  title: string;
  slug: string;
  content: string;
  isPublished: boolean;
  lastUpdated: string;
}

export interface StorefrontPolicies {
  shippingDelivery: PolicyDocument;
  returns: PolicyDocument;
  refunds: PolicyDocument;
  cancellations: PolicyDocument;
  terms: PolicyDocument;
  privacy: PolicyDocument;
}

export interface StorefrontContentDto {
  version: number;
  publishedAt: string;
  publishedBy?: string;
  announcement: AnnouncementContent;
  hero: HeroContent;
  categories: CategorySectionContent;
  featured: FeaturedSectionContent;
  process: ProcessSectionContent;
  story: StorySectionContent;
  faqs: FaqSectionContent;
  trust: TrustSectionContent;
  finalCta: FinalCtaContent;
  policies: StorefrontPolicies;
}

export interface StorefrontDraftDto {
  draft: StorefrontContentDto;
  published: StorefrontContentDto;
  hasUnpublishedChanges: boolean;
  lastModifiedAt: string;
  lastModifiedBy?: string;
}
