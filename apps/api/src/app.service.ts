import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getRoot(): { message: string } {
    return { message: 'Vishkaraa API v1' };
  }
}
