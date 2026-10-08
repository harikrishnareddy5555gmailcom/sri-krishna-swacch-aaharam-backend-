/**
 * Backend Foundation Tests
 *
 * Verifies:
 * 1. AppService is instantiable
 * 2. AppService returns expected root message
 */
import { describe, it, expect } from 'vitest';
import { AppService } from '../src/app.service.js';

describe('AppService', () => {
  it('should be defined', () => {
    const service = new AppService();
    expect(service).toBeDefined();
  });

  it('should return API root message', () => {
    const service = new AppService();
    const result = service.getRoot();
    expect(result).toEqual({ message: 'Vishkaraa API v1' });
  });
});
