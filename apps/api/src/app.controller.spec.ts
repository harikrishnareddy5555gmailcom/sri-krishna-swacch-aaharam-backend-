/**
 * AppController Foundation Test
 *
 * Verifies the root controller returns the expected API message.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(() => {
    appController = new AppController(new AppService());
  });

  describe('getRoot', () => {
    it('should return Vishkaraa API v1 message', () => {
      expect(appController.getRoot()).toEqual({ message: 'Vishkaraa API v1' });
    });
  });
});
