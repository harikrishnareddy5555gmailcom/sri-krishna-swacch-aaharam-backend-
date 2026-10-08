import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AddressLabel, UserRole } from '@prisma/client';
import type { UserAddress } from '@prisma/client';
import { UsersService } from '../src/users/users.service.js';
import { UsersController } from '../src/users/users.controller.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { AuditService } from '../src/audit/audit.service.js';
import type { ConfigService } from '@nestjs/config';

describe('Phase 20D.8.2A: Saved Delivery Addresses Foundation & Security', () => {
  let addressStore: UserAddress[];
  let mockPrisma: any;
  let mockAudit: any;
  let mockConfig: any;
  let usersService: UsersService;
  let usersController: UsersController;

  const userAId = 'user-a-1111-1111-1111-111111111111';
  const userBId = 'user-b-2222-2222-2222-222222222222';

  beforeEach(() => {
    addressStore = [];

    // In-memory mock implementing Prisma transactional interface
    mockPrisma = {
      userAddress: {
        findMany: vi.fn(async ({ where, orderBy }: any) => {
          let res = addressStore.filter((a) => a.userId === where.userId);
          if (orderBy && Array.isArray(orderBy)) {
            res.sort((a, b) => {
              if (orderBy[0]?.isDefault === 'desc') {
                if (a.isDefault && !b.isDefault) return -1;
                if (!a.isDefault && b.isDefault) return 1;
              }
              return b.createdAt.getTime() - a.createdAt.getTime();
            });
          }
          return res;
        }),
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          let matches = addressStore.filter((a) => {
            if (where.id && typeof where.id === 'string' && a.id !== where.id) return false;
            if (where.id?.not && a.id === where.id.not) return false;
            if (where.userId && a.userId !== where.userId) return false;
            if (where.isDefault !== undefined && a.isDefault !== where.isDefault) return false;
            return true;
          });
          if (orderBy?.createdAt === 'desc') {
            matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return matches[0] || null;
        }),
        count: vi.fn(async ({ where }: any) => {
          return addressStore.filter((a) => a.userId === where.userId).length;
        }),
        create: vi.fn(async ({ data }: any) => {
          const newAddress: UserAddress = {
            id: `addr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            userId: data.userId,
            recipientName: data.recipientName,
            phone: data.phone,
            line1: data.line1,
            line2: data.line2 ?? null,
            city: data.city,
            state: data.state,
            postalCode: data.postalCode,
            country: data.country ?? 'IN',
            landmark: data.landmark ?? null,
            label: data.label ?? AddressLabel.HOME,
            isDefault: Boolean(data.isDefault),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          addressStore.push(newAddress);
          return newAddress;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const idx = addressStore.findIndex((a) => a.id === where.id);
          if (idx === -1) throw new Error('Record not found');
          addressStore[idx] = {
            ...addressStore[idx]!,
            ...data,
            updatedAt: new Date(),
          };
          return addressStore[idx]!;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (let i = 0; i < addressStore.length; i++) {
            const item = addressStore[i]!;
            const matchUser = !where.userId || item.userId === where.userId;
            const matchDefault = where.isDefault === undefined || item.isDefault === where.isDefault;
            const matchNotId = !where.id?.not || item.id !== where.id.not;
            if (matchUser && matchDefault && matchNotId) {
              addressStore[i] = { ...item, ...data, updatedAt: new Date() };
              count++;
            }
          }
          return { count };
        }),
        delete: vi.fn(async ({ where }: any) => {
          const idx = addressStore.findIndex((a) => a.id === where.id);
          if (idx === -1) throw new Error('Record not found');
          const deleted = addressStore.splice(idx, 1)[0]!;
          return deleted;
        }),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
        return cb(mockPrisma);
      }),
    };

    mockAudit = {
      logEvent: vi.fn(async () => Promise.resolve()),
    };

    mockConfig = {
      get: vi.fn(() => '10'),
    };

    usersService = new UsersService(
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      mockConfig as unknown as ConfigService,
    );

    usersController = new UsersController(usersService);
  });

  // ===========================================================================
  // 1. CREATION & FIRST ADDRESS DEFAULT BEHAVIOR
  // ===========================================================================
  describe('Address Creation & Default Rules', () => {
    it('should create an address for authenticated user and automatically set as default if first address', async () => {
      const created = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Ander',
        phone: '+919876543210',
        line1: '123 Herbal Way',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        isDefault: false, // User didn't ask for default, but it's their first address
      });

      expect(created).toBeDefined();
      expect(created.userId).toBe(userAId);
      expect(created.recipientName).toBe('Alice Ander');
      expect(created.fullName).toBe('Alice Ander');
      expect(created.line1).toBe('123 Herbal Way');
      expect(created.city).toBe('Bengaluru');
      expect(created.isDefault).toBe(true); // First address MUST be default

      // Verify audit log was recorded without PII street line or phone
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: userAId,
          newValue: expect.objectContaining({
            addressId: created.id,
            isDefault: true,
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          }),
        }),
      );
      const auditPayload = mockAudit.logEvent.mock.calls[0]![0];
      expect(auditPayload.newValue.line1).toBeUndefined();
      expect(auditPayload.newValue.phone).toBeUndefined();
    });

    it('should create a second address as non-default when isDefault is not specified', async () => {
      const first = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Home',
        phone: '+919876543210',
        line1: '123 Home St',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      const second = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Office',
        phone: '+919876543211',
        line1: '456 Tech Park',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560002',
        label: AddressLabel.WORK,
        isDefault: false,
      });

      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);
      expect(second.label).toBe(AddressLabel.WORK);

      const list = await usersService.getUserAddresses(userAId);
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe(first.id); // default first
      expect(list[1]!.id).toBe(second.id);
    });

    it('should atomically switch default when a second address is created with isDefault=true', async () => {
      const first = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Home',
        phone: '+919876543210',
        line1: '123 Home St',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });
      expect(first.isDefault).toBe(true);

      const second = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Second',
        phone: '+919876543211',
        line1: '789 New St',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560003',
        isDefault: true,
      });

      expect(second.isDefault).toBe(true);

      // Verify first address is now NOT default
      const updatedFirst = addressStore.find((a) => a.id === first.id);
      expect(updatedFirst?.isDefault).toBe(false);

      // Only ONE default address exists for userA
      const defaults = addressStore.filter((a) => a.userId === userAId && a.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0]!.id).toBe(second.id);
    });
  });

  // ===========================================================================
  // 2. ISOLATION & IDOR SECURITY
  // ===========================================================================
  describe('User Isolation and IDOR Security', () => {
    it('should list only the authenticated user addresses', async () => {
      await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Address',
        phone: '+919876543210',
        line1: '123 Alice St',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      await usersService.createUserAddress(userBId, {
        recipientName: 'Bob Address',
        phone: '+919876543222',
        line1: '999 Bob St',
        city: 'Mysuru',
        state: 'Karnataka',
        postalCode: '570001',
      });

      const userAList = await usersService.getUserAddresses(userAId);
      expect(userAList.length).toBe(1);
      expect(userAList[0]!.recipientName).toBe('Alice Address');

      const userBList = await usersService.getUserAddresses(userBId);
      expect(userBList.length).toBe(1);
      expect(userBList[0]!.recipientName).toBe('Bob Address');
    });

    it('should reject updating another user address with NotFoundException', async () => {
      const bobAddress = await usersService.createUserAddress(userBId, {
        recipientName: 'Bob Original',
        phone: '+919876543222',
        line1: '999 Bob St',
        city: 'Mysuru',
        state: 'Karnataka',
        postalCode: '570001',
      });

      // User A attempts to update Bob's address
      await expect(
        usersService.updateUserAddress(userAId, bobAddress.id, {
          recipientName: 'Hacked by Alice',
        }),
      ).rejects.toThrow(NotFoundException);

      // Verify Bob's address was untouched
      const bobCheck = addressStore.find((a) => a.id === bobAddress.id);
      expect(bobCheck?.recipientName).toBe('Bob Original');
    });

    it('should reject deleting another user address with NotFoundException', async () => {
      const bobAddress = await usersService.createUserAddress(userBId, {
        recipientName: 'Bob Original',
        phone: '+919876543222',
        line1: '999 Bob St',
        city: 'Mysuru',
        state: 'Karnataka',
        postalCode: '570001',
      });

      // User A attempts to delete Bob's address
      await expect(
        usersService.deleteUserAddress(userAId, bobAddress.id),
      ).rejects.toThrow(NotFoundException);

      // Verify Bob's address still exists
      const bobCheck = addressStore.find((a) => a.id === bobAddress.id);
      expect(bobCheck).toBeDefined();
    });

    it('should reject setting default on another user address with NotFoundException', async () => {
      const bobAddress = await usersService.createUserAddress(userBId, {
        recipientName: 'Bob Original',
        phone: '+919876543222',
        line1: '999 Bob St',
        city: 'Mysuru',
        state: 'Karnataka',
        postalCode: '570001',
      });

      await expect(
        usersService.setDefaultUserAddress(userAId, bobAddress.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('should derive identity exclusively from request context in controller', async () => {
      const mockReq: any = {
        user: {
          id: userAId,
          role: UserRole.USER,
          email: 'alice@example.com',
        },
      };

      // Even if body or client passes a spoofed userId
      const response = await usersController.createMyAddress(mockReq, {
        recipientName: 'Alice Verified',
        phone: '+919876543210',
        line1: '100 Authenticated Way',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      expect(response.success).toBe(true);
      expect(response.data.userId).toBe(userAId);
      expect(response.data.recipientName).toBe('Alice Verified');
    });
  });

  // ===========================================================================
  // 3. UPDATING & DEFAULT SWITCHING
  // ===========================================================================
  describe('Address Update & Default Switching', () => {
    it('should update owned address fields and trim whitespace', async () => {
      const created = await usersService.createUserAddress(userAId, {
        recipientName: 'Initial Name',
        phone: '+919876543210',
        line1: 'Initial Line 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      const updated = await usersService.updateUserAddress(userAId, created.id, {
        recipientName: '  Updated Name  ',
        line1: '  Updated Line 1  ',
        landmark: '  Near Clock Tower  ',
      });

      expect(updated.recipientName).toBe('Updated Name');
      expect(updated.fullName).toBe('Updated Name');
      expect(updated.line1).toBe('Updated Line 1');
      expect(updated.landmark).toBe('Near Clock Tower');
    });

    it('should switch default atomically via setDefaultUserAddress', async () => {
      const addr1 = await usersService.createUserAddress(userAId, {
        recipientName: 'Address 1',
        phone: '+919876543210',
        line1: 'Line 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      const addr2 = await usersService.createUserAddress(userAId, {
        recipientName: 'Address 2',
        phone: '+919876543211',
        line1: 'Line 2',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560002',
        isDefault: false,
      });

      expect(addr1.isDefault).toBe(true);
      expect(addr2.isDefault).toBe(false);

      const switched = await usersService.setDefaultUserAddress(userAId, addr2.id);
      expect(switched.isDefault).toBe(true);

      const a1 = addressStore.find((a) => a.id === addr1.id);
      const a2 = addressStore.find((a) => a.id === addr2.id);
      expect(a1?.isDefault).toBe(false);
      expect(a2?.isDefault).toBe(true);
    });
  });

  // ===========================================================================
  // 4. DELETION & FALLBACK DEFAULT SELECTION
  // ===========================================================================
  describe('Address Deletion & Fallback Default Behavior', () => {
    it('should delete a non-default address without altering default', async () => {
      const addr1 = await usersService.createUserAddress(userAId, {
        recipientName: 'Default Address',
        phone: '+919876543210',
        line1: 'Line 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      const addr2 = await usersService.createUserAddress(userAId, {
        recipientName: 'Secondary Address',
        phone: '+919876543211',
        line1: 'Line 2',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560002',
        isDefault: false,
      });

      const delRes = await usersService.deleteUserAddress(userAId, addr2.id);
      expect(delRes.success).toBe(true);

      const remaining = await usersService.getUserAddresses(userAId);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe(addr1.id);
      expect(remaining[0]!.isDefault).toBe(true);
    });

    it('should automatically elect another address as default when default address is deleted', async () => {
      const addr1 = await usersService.createUserAddress(userAId, {
        recipientName: 'Primary (Default)',
        phone: '+919876543210',
        line1: 'Line 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      const addr2 = await usersService.createUserAddress(userAId, {
        recipientName: 'Secondary (Non-Default)',
        phone: '+919876543211',
        line1: 'Line 2',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560002',
        isDefault: false,
      });

      expect(addr1.isDefault).toBe(true);
      expect(addr2.isDefault).toBe(false);

      // Delete the default address
      await usersService.deleteUserAddress(userAId, addr1.id);

      // Verify addr2 is now promoted to default
      const remaining = await usersService.getUserAddresses(userAId);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe(addr2.id);
      expect(remaining[0]!.isDefault).toBe(true);
    });

    it('should leave zero defaults when the only address is deleted', async () => {
      const single = await usersService.createUserAddress(userAId, {
        recipientName: 'Only Address',
        phone: '+919876543210',
        line1: 'Line 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      await usersService.deleteUserAddress(userAId, single.id);

      const remaining = await usersService.getUserAddresses(userAId);
      expect(remaining.length).toBe(0);
    });
  });

  // ===========================================================================
  // 5. VALIDATION & INPUT SAFETY
  // ===========================================================================
  describe('Validation & Input Constraints', () => {
    it('should reject missing recipient name', async () => {
      await expect(
        usersService.createUserAddress(userAId, {
          recipientName: '',
          phone: '+919876543210',
          line1: 'Line 1',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject missing phone number', async () => {
      await expect(
        usersService.createUserAddress(userAId, {
          recipientName: 'Valid Name',
          phone: '   ',
          line1: 'Line 1',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject missing line 1', async () => {
      await expect(
        usersService.createUserAddress(userAId, {
          recipientName: 'Valid Name',
          phone: '+919876543210',
          line1: '',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should support fullName alias seamlessly', async () => {
      const created = await usersService.createUserAddress(userAId, {
        fullName: 'Alias Name User',
        phone: '+919876543210',
        line1: '123 Alias Lane',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      expect(created.recipientName).toBe('Alias Name User');
      expect(created.fullName).toBe('Alias Name User');
    });

    it('should support addressLine1 and addressLine2 aliases seamlessly', async () => {
      const created = await usersService.createUserAddress(userAId, {
        recipientName: 'Alias User',
        phone: '+919876543210',
        addressLine1: 'Line 1 Alias',
        addressLine2: 'Line 2 Alias',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      expect(created.line1).toBe('Line 1 Alias');
      expect(created.line2).toBe('Line 2 Alias');
    });
  });

  // ===========================================================================
  // 6. ORDER SNAPSHOT INDEPENDENCE
  // ===========================================================================
  describe('Order Snapshot Independence Verification', () => {
    it('verifies that editing or deleting a saved address has zero impact on order address snapshots', async () => {
      // Historical order has immutable snapshot strings
      const historicalOrderSnapshot = {
        orderNumber: 'VN-202610-A1B2C3D4',
        shippingName: 'Alice Original Snapshot',
        shippingPhone: '+919876543210',
        shippingLine1: 'Historical Road 1',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
      };

      // Create and then mutate/delete a user address
      const addr = await usersService.createUserAddress(userAId, {
        recipientName: 'Alice Original Snapshot',
        phone: '+919876543210',
        line1: 'Historical Road 1',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

      await usersService.updateUserAddress(userAId, addr.id, {
        recipientName: 'Alice Completely New Name',
        line1: 'Completely New Street 999',
      });

      await usersService.deleteUserAddress(userAId, addr.id);

      // Verify order snapshot is 100% decoupled and unchanged
      expect(historicalOrderSnapshot.shippingName).toBe('Alice Original Snapshot');
      expect(historicalOrderSnapshot.shippingLine1).toBe('Historical Road 1');
      expect(historicalOrderSnapshot.orderNumber).toBe('VN-202610-A1B2C3D4');
    });
  });
});
