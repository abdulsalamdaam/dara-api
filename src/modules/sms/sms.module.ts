import { Global, Module } from "@nestjs/common";
import { TaqnyatService } from "./taqnyat.service";
import { PhoneOtpService } from "./phone-otp.service";

/**
 * SMS + phone-OTP. Global, like the Twilio module it replaces, so any feature
 * that needs to text a customer can inject it without re-importing.
 */
@Global()
@Module({
  providers: [TaqnyatService, PhoneOtpService],
  exports: [TaqnyatService, PhoneOtpService],
})
export class SmsModule {}
