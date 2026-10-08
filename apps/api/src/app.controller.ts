import { Controller, Get, Version } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Version('1')
  getRoot(): { message: string } {
    return this.appService.getRoot();
  }
}
