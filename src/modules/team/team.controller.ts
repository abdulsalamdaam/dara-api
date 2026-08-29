import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { TeamService } from "./team.service";
import { IsArray, IsBoolean, IsEmail, IsOptional, IsString } from "class-validator";

class CreateEmployeeDto {
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() preset?: string;
  @IsOptional() @IsArray() permissions?: string[];
  @IsOptional() @IsString() roleLabel?: string;
}

class UpdateEmployeeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() preset?: string;
  @IsOptional() @IsArray() permissions?: string[];
  @IsOptional() @IsString() roleLabel?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags("team")
@ApiBearerAuth("user-jwt")
@Controller("team")
@UseGuards(JwtAuthGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  /**
   * The team list. `search`, `role` and `isActive` filter in SQL; `page` /
   * `pageSize` / `paginated` switch on the `{ data, page, pageSize, total }`
   * envelope. Sending none of them returns the bare array as before.
   */
  @Get("employees")
  list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    return this.team.listEmployees(user.id, rawQuery);
  }

  @Post("employees")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateEmployeeDto) {
    return this.team.createEmployee(user.id, body);
  }

  @Patch("employees/:id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEmployeeDto,
  ) {
    return this.team.updateEmployee(user.id, id, body);
  }

  @Patch("employees/:id/permissions")
  updatePermissions(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { permissions: string[] },
  ) {
    return this.team.updateEmployeePermissions(user.id, id, body?.permissions ?? []);
  }

  @Delete("employees/:id")
  remove(@CurrentUser() user: AuthUser, @Param("id", ParseIntPipe) id: number) {
    return this.team.deleteEmployee(user.id, id);
  }

  @Post("employees/:id/reset-password")
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { password: string },
  ) {
    return this.team.resetEmployeePassword(user.id, id, body.password);
  }

  @Post("employees/:id/resend-verification")
  resendVerification(@CurrentUser() user: AuthUser, @Param("id", ParseIntPipe) id: number) {
    return this.team.resendEmployeeVerification(user.id, id);
  }

  @Get("role-presets")
  presets() {
    return this.team.rolePresets();
  }
}
