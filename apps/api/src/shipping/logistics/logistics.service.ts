import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { LogisticsRoutingEngine } from './logistics-routing.engine.js';
import {
  type ServiceabilityRequest,
  type ServiceabilityResponse,
  type RateCardInfo,
  type PincodeZoneInfo,
} from './interfaces/courier-adapter.interface.js';
import {
  CreateCourierPartnerDto,
  UpdateCourierPartnerDto,
  CreateRateCardDto,
  CreateBlacklistedPincodeDto,
} from './dto/estimate-delivery.dto.js';
import { Prisma } from '@prisma/client';

@Injectable()
export class LogisticsService implements OnModuleInit {
  private readonly logger = new Logger(LogisticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routingEngine: LogisticsRoutingEngine,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaultLogisticsConfig();
  }

  /**
   * Seeds standard Indian logistics carrier partners and rate cards if database is unseeded.
   */
  private async seedDefaultLogisticsConfig(): Promise<void> {
    try {
      const partnerCount = await this.prisma.courierPartner.count();
      if (partnerCount === 0) {
        this.logger.log('Initializing default multi-carrier logistics partners & rate cards...');

        const partnersData = [
          {
            name: 'Delhivery Express',
            code: 'DELHIVERY',
            isActive: true,
            priority: 1,
            isSurfaceHeavy: false,
            rateCards: {
              create: {
                minWeightKg: 0,
                maxWeightKg: 5.0,
                baseRate: 65.0,
                perKgRate: 30.0,
                expectedTransitDays: 3,
              },
            },
          },
          {
            name: 'Blue Dart Air Express',
            code: 'BLUEDART',
            isActive: true,
            priority: 2,
            isSurfaceHeavy: false,
            rateCards: {
              create: {
                minWeightKg: 0,
                maxWeightKg: 5.0,
                baseRate: 95.0,
                perKgRate: 45.0,
                expectedTransitDays: 2,
              },
            },
          },
          {
            name: 'Xpressbees Express',
            code: 'XPRESSBEES',
            isActive: true,
            priority: 3,
            isSurfaceHeavy: false,
            rateCards: {
              create: {
                minWeightKg: 0,
                maxWeightKg: 5.0,
                baseRate: 58.0,
                perKgRate: 26.0,
                expectedTransitDays: 4,
              },
            },
          },
          {
            name: 'Shiprocket Smart Routing',
            code: 'SHIPROCKET',
            isActive: true,
            priority: 4,
            isSurfaceHeavy: false,
            rateCards: {
              create: {
                minWeightKg: 0,
                maxWeightKg: 5.0,
                baseRate: 62.0,
                perKgRate: 28.0,
                expectedTransitDays: 3,
              },
            },
          },
          {
            name: 'Heavy Surface Logistics (V-Trans / Spoton / Rivigo)',
            code: 'HEAVY_SURFACE',
            isActive: true,
            priority: 5,
            isSurfaceHeavy: true, // Dedicated bulk/B2B carrier (>= 5 kg)
            rateCards: {
              create: {
                minWeightKg: 5.0,
                maxWeightKg: 100.0,
                baseRate: 150.0,
                perKgRate: 12.0, // Discounted bulk per-kg freight rate
                expectedTransitDays: 5,
              },
            },
          },
          {
            name: 'India Post Speed Post',
            code: 'INDIA_POST',
            isActive: true,
            priority: 6,
            isSurfaceHeavy: false,
            rateCards: {
              create: {
                minWeightKg: 0,
                maxWeightKg: 35.0,
                baseRate: 55.0,
                perKgRate: 25.0,
                expectedTransitDays: 5,
              },
            },
          },
        ];

        for (const p of partnersData) {
          await this.prisma.courierPartner.create({ data: p });
        }

        // Seed some metro PIN code zones for instant ultra-accurate routing
        await this.prisma.pincodeZone.createMany({
          data: [
            { pincode: '560001', district: 'Bengaluru Urban', state: 'Karnataka', zoneType: 'METRO', isServiceable: true },
            { pincode: '560034', district: 'Bengaluru Urban', state: 'Karnataka', zoneType: 'METRO', isServiceable: true },
            { pincode: '600001', district: 'Chennai', state: 'Tamil Nadu', zoneType: 'METRO', isServiceable: true },
            { pincode: '400001', district: 'Mumbai', state: 'Maharashtra', zoneType: 'METRO', isServiceable: true },
            { pincode: '110001', district: 'New Delhi', state: 'Delhi', zoneType: 'METRO', isServiceable: true },
            { pincode: '500001', district: 'Hyderabad', state: 'Telangana', zoneType: 'METRO', isServiceable: true },
            { pincode: '700001', district: 'Kolkata', state: 'West Bengal', zoneType: 'METRO', isServiceable: true },
            { pincode: '641001', district: 'Coimbatore', state: 'Tamil Nadu', zoneType: 'TIER2', isServiceable: true },
            { pincode: '682001', district: 'Ernakulam', state: 'Kerala', zoneType: 'TIER2', isServiceable: true },
          ],
          skipDuplicates: true,
        });

        this.logger.log('Default multi-carrier logistics config successfully seeded.');
      }
    } catch (err: unknown) {
      this.logger.warn(`Logistics default seed check: ${(err as Error).message}`);
    }
  }

  /**
   * Evaluates serviceability and computes optimal logistics estimate
   */
  async estimateDelivery(request: ServiceabilityRequest): Promise<ServiceabilityResponse> {
    const cleanPin = request.pincode.trim();

    // 1. Check if PIN code is blacklisted
    const blacklisted = await this.prisma.blacklistedPincode.findUnique({
      where: { pincode: cleanPin },
    });

    // 2. Fetch Pincode Zone details (if pre-mapped in DB)
    const zoneRecord = await this.prisma.pincodeZone.findUnique({
      where: { pincode: cleanPin },
    });
    const zoneInfo: PincodeZoneInfo | null = zoneRecord
      ? {
          pincode: zoneRecord.pincode,
          district: zoneRecord.district,
          state: zoneRecord.state,
          zoneType: zoneRecord.zoneType,
          isServiceable: zoneRecord.isServiceable,
        }
      : null;

    // 3. Load active courier partners and their rate cards from DB
    const activeCouriers = await this.prisma.courierPartner.findMany({
      where: { isActive: true },
      include: { rateCards: true },
    });

    const activeCourierCodes = new Set<string>();
    const rateCardsByCourier = new Map<string, RateCardInfo>();

    for (const c of activeCouriers) {
      activeCourierCodes.add(c.code);
      if (c.rateCards.length > 0) {
        const rc = c.rateCards[0]!;
        rateCardsByCourier.set(c.code, {
          id: rc.id,
          minWeightKg: rc.minWeightKg,
          maxWeightKg: rc.maxWeightKg,
          baseRate: rc.baseRate,
          perKgRate: rc.perKgRate,
          expectedTransitDays: rc.expectedTransitDays,
        });
      }
    }

    // 4. Delegate to the Smart Routing Engine
    return await this.routingEngine.evaluateServiceability(request, {
      isBlacklisted: Boolean(blacklisted),
      blacklistReason: blacklisted?.reason,
      zoneInfo,
      rateCardsByCourier,
      activeCourierCodes,
    });
  }

  // ===========================================================================
  // ADMIN MANAGEMENT METHODS
  // ===========================================================================

  async getAllCourierPartners() {
    return this.prisma.courierPartner.findMany({
      include: { rateCards: true },
      orderBy: { priority: 'asc' },
    });
  }

  async createCourierPartner(dto: CreateCourierPartnerDto) {
    const existing = await this.prisma.courierPartner.findUnique({
      where: { code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new ConflictException(`Courier partner with code ${dto.code} already exists`);
    }

    const partner = await this.prisma.courierPartner.create({
      data: {
        name: dto.name,
        code: dto.code.toUpperCase(),
        isActive: dto.isActive ?? true,
        priority: dto.priority ?? 1,
        isSurfaceHeavy: dto.isSurfaceHeavy ?? false,
        apiCredentials: (dto.apiCredentials as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    this.routingEngine.clearCache();
    return partner;
  }

  async updateCourierPartner(id: string, dto: UpdateCourierPartnerDto) {
    const existing = await this.prisma.courierPartner.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Courier partner with ID ${id} not found`);
    }

    const partner = await this.prisma.courierPartner.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.isSurfaceHeavy !== undefined && { isSurfaceHeavy: dto.isSurfaceHeavy }),
        ...(dto.apiCredentials && {
          apiCredentials: dto.apiCredentials as Prisma.InputJsonValue,
        }),
      },
    });

    this.routingEngine.clearCache();
    return partner;
  }

  async getAllRateCards() {
    return this.prisma.rateCard.findMany({
      include: { courier: { select: { name: true, code: true, isSurfaceHeavy: true } } },
    });
  }

  async createRateCard(dto: CreateRateCardDto) {
    const courier = await this.prisma.courierPartner.findUnique({
      where: { id: dto.courierId },
    });
    if (!courier) {
      throw new NotFoundException(`Courier partner with ID ${dto.courierId} not found`);
    }

    const card = await this.prisma.rateCard.create({
      data: {
        courierId: dto.courierId,
        minWeightKg: dto.minWeightKg,
        maxWeightKg: dto.maxWeightKg,
        baseRate: dto.baseRate,
        perKgRate: dto.perKgRate,
        expectedTransitDays: dto.expectedTransitDays,
      },
    });

    this.routingEngine.clearCache();
    return card;
  }

  async getAllBlacklistedPincodes() {
    return this.prisma.blacklistedPincode.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async addBlacklistedPincode(dto: CreateBlacklistedPincodeDto) {
    const cleanPin = dto.pincode.trim();
    const item = await this.prisma.blacklistedPincode.upsert({
      where: { pincode: cleanPin },
      create: { pincode: cleanPin, reason: dto.reason },
      update: { reason: dto.reason },
    });

    this.routingEngine.clearCache(cleanPin);
    return item;
  }

  async removeBlacklistedPincode(pincode: string) {
    const cleanPin = pincode.trim();
    await this.prisma.blacklistedPincode.deleteMany({
      where: { pincode: cleanPin },
    });
    this.routingEngine.clearCache(cleanPin);
    return { success: true, message: `PIN code ${cleanPin} removed from blacklist.` };
  }

  // ===========================================================================
  // PINCODE INTELLIGENCE & AREA DETECTION (Zero CORS Server-Side Provider)
  // ===========================================================================

  private readonly pincodeCache = new Map<string, { data: PincodeDetailsResponse; expiresAt: number }>();

  async lookupPincode(pincode: string): Promise<PincodeDetailsResponse> {
    const cleanPin = pincode.trim().replace(/\D/g, '');
    if (cleanPin.length !== 6) {
      return {
        success: false,
        pincode: cleanPin,
        district: '',
        state: '',
        areas: [],
        primaryArea: '',
        postOffices: [],
        zoneType: 'UNKNOWN',
        isServiceable: false,
        isBlacklisted: false,
      };
    }

    // 1. Check in-memory cache
    const cached = this.pincodeCache.get(cleanPin);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // 2. Check blacklist in DB
    const blacklisted = await this.prisma.blacklistedPincode.findUnique({
      where: { pincode: cleanPin },
    });

    // 3. Check DB PincodeZone
    const zone = await this.prisma.pincodeZone.findUnique({
      where: { pincode: cleanPin },
    });

    let district = zone?.district || '';
    let state = zone?.state || '';
    let circle = '';
    let areas: string[] = [];
    let postOffices: any[] = [];

    // 4. Server-Side fetch to India Post Directory (No browser CORS restrictions!)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`https://api.postalpincode.in/pincode/${cleanPin}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json) && json[0]?.Status === 'Success' && Array.isArray(json[0].PostOffice)) {
          postOffices = json[0].PostOffice;
          areas = postOffices.map((po: any) => po.Name).filter(Boolean);
          const first = postOffices[0];
          if (!district && first) {
            district = first.District || first.Block || first.Division || '';
          }
          if (!state && first) {
            state = first.State || '';
          }
          if (first?.Circle) {
            circle = first.Circle;
          }
        }
      }
    } catch (err: unknown) {
      this.logger.debug(`Remote postal lookup fallback for ${cleanPin}: ${(err as Error).message}`);
    }

    // 5. Algorithmic fallback if external postal API was offline or returned empty
    if (!district || !state) {
      const inferred = this.inferRegionFromPincode(cleanPin);
      if (!state) state = inferred.state;
      if (!district) district = inferred.district;
      if (areas.length === 0) areas = [inferred.city];
    }

    const primaryArea = areas[0] || district || 'City Center';
    const zoneType = zone?.zoneType || this.inferZoneType(cleanPin);
    const isServiceable = !blacklisted;

    const result: PincodeDetailsResponse = {
      success: true,
      pincode: cleanPin,
      district,
      state,
      circle,
      areas,
      primaryArea,
      postOffices: postOffices.map((po: any) => ({
        name: po.Name,
        branchType: po.BranchType,
        deliveryStatus: po.DeliveryStatus,
        circle: po.Circle,
        district: po.District,
        state: po.State,
      })),
      zoneType,
      isServiceable,
      isBlacklisted: Boolean(blacklisted),
      blacklistReason: blacklisted?.reason,
    };

    // Cache in-memory for 24 hours
    this.pincodeCache.set(cleanPin, {
      data: result,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    return result;
  }

  private inferRegionFromPincode(pin: string): { state: string; city: string; district: string } {
    const firstTwo = pin.slice(0, 2);
    const firstDigit = pin[0];

    // Sub-circle refined routing
    if (firstTwo === '11') return { state: 'Delhi', city: 'New Delhi', district: 'Delhi' };
    if (firstTwo === '12' || firstTwo === '13') return { state: 'Haryana', city: 'Gurugram / Faridabad', district: 'Haryana Central' };
    if (firstTwo === '14' || firstTwo === '15') return { state: 'Punjab', city: 'Ludhiana / Amritsar', district: 'Punjab Hub' };
    if (firstTwo === '16') return { state: 'Chandigarh', city: 'Chandigarh', district: 'Chandigarh' };
    if (firstTwo === '17') return { state: 'Himachal Pradesh', city: 'Shimla', district: 'Himachal' };
    if (firstTwo === '18' || firstTwo === '19') return { state: 'Jammu & Kashmir', city: 'Srinagar / Jammu', district: 'J&K' };

    if (firstTwo >= '20' && firstTwo <= '28') return { state: 'Uttar Pradesh', city: 'Noida / Lucknow', district: 'Uttar Pradesh' };
    if (firstTwo === '24') return { state: 'Uttarakhand', city: 'Dehradun', district: 'Uttarakhand' };

    if (firstTwo >= '30' && firstTwo <= '34') return { state: 'Rajasthan', city: 'Jaipur', district: 'Rajasthan' };
    if (firstTwo >= '36' && firstTwo <= '39') return { state: 'Gujarat', city: 'Ahmedabad / Surat', district: 'Gujarat' };

    if (firstTwo === '40') return { state: 'Maharashtra', city: 'Mumbai', district: 'Mumbai' };
    if (firstTwo === '41') return { state: 'Maharashtra', city: 'Pune', district: 'Pune' };
    if (firstTwo === '42' || firstTwo === '43' || firstTwo === '44') return { state: 'Maharashtra', city: 'Nagpur / Nashik', district: 'Maharashtra' };
    if (firstTwo === '40' && pin.startsWith('403')) return { state: 'Goa', city: 'Panaji', district: 'Goa' };
    if (firstTwo >= '45' && firstTwo <= '48') return { state: 'Madhya Pradesh', city: 'Bhopal / Indore', district: 'Madhya Pradesh' };
    if (firstTwo === '49') return { state: 'Chhattisgarh', city: 'Raipur', district: 'Chhattisgarh' };

    if (firstTwo >= '50' && firstTwo <= '53') return { state: 'Andhra Pradesh / Telangana', city: 'Hyderabad', district: 'Telangana / AP' };
    if (firstTwo === '56') return { state: 'Karnataka', city: 'Bengaluru', district: 'Bengaluru Urban' };
    if (firstTwo === '57' || firstTwo === '58' || firstTwo === '59') return { state: 'Karnataka', city: 'Mysuru / Hubballi', district: 'Karnataka' };

    if (firstTwo === '60') return { state: 'Tamil Nadu', city: 'Chennai', district: 'Chennai' };
    if (firstTwo === '61' || firstTwo === '62') return { state: 'Tamil Nadu', city: 'Madurai / Tiruchirappalli', district: 'Tamil Nadu Central' };
    if (firstTwo === '63' || firstTwo === '64') return { state: 'Tamil Nadu', city: 'Coimbatore / Salem', district: 'Tamil Nadu West' };
    if (firstTwo >= '67' && firstTwo <= '69') return { state: 'Kerala', city: 'Kochi / Thiruvananthapuram', district: 'Kerala' };

    if (firstTwo >= '70' && firstTwo <= '74') return { state: 'West Bengal', city: 'Kolkata', district: 'West Bengal' };
    if (firstTwo === '75' || firstTwo === '76' || firstTwo === '77') return { state: 'Odisha', city: 'Bhubaneswar', district: 'Odisha' };
    if (firstTwo === '78' || firstTwo === '79') return { state: 'Assam & North East', city: 'Guwahati', district: 'Assam / North East' };

    if (firstTwo >= '80' && firstTwo <= '85') return { state: 'Bihar / Jharkhand', city: 'Patna / Ranchi', district: 'Bihar / Jharkhand' };

    return { state: 'India', city: 'National Postal Network', district: 'General Service' };
  }

  private inferZoneType(pin: string): string {
    const metroPrefixes = ['11', '40', '56', '60', '50', '70', '38', '41'];
    return metroPrefixes.includes(pin.slice(0, 2)) ? 'METRO' : 'REST_OF_INDIA';
  }
}

export interface PincodeDetailsResponse {
  success: boolean;
  pincode: string;
  district: string;
  state: string;
  circle?: string;
  areas: string[];
  primaryArea: string;
  postOffices: Array<{
    name: string;
    branchType?: string;
    deliveryStatus?: string;
    circle?: string;
    district?: string;
    state?: string;
  }>;
  zoneType: string;
  isServiceable: boolean;
  isBlacklisted: boolean;
  blacklistReason?: string;
}
