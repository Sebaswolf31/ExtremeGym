import { BadRequestException, Injectable } from '@nestjs/common';
import { CreateUserDto, LoginUserDto } from '../users/dto/create-user.dto';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt/dist';
import { User } from '../users/entities/user.entity';
import * as bcrypt from 'bcrypt';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { Account } from './entities/account.entity';
import { StripeService } from 'src/stripe/stripe.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private jwtService: JwtService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
    private readonly stripeService: StripeService,
  ) {}

  async createUser(user: CreateUserDto) {
    const { email, password, confirmPassword, ...userWithoutConfirmation } =
      user;

    // ✅ Crear cliente en Stripe
    const customer = await this.stripeService.createCustomer(email);
    // ✅ Crear suscripción gratuita para el usuario
    const freePlanId = 'price_1R9Imk2LBi4exdRbWcRfF1Go';
    const subscription = await this.stripeService.createSubscription(
      customer.id,
      freePlanId,
    );

    const existingUser = await this.usersRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      if (!existingUser.isActive) {
        // Si el usuario existe pero está inactivo, reactivarlo
        existingUser.isActive = true;
        Object.assign(existingUser, userWithoutConfirmation); // Actualizar otros datos proporcionados
        if (password) {
          const hashedPassword = await bcrypt.hash(password, 10);
          existingUser.password = hashedPassword; // Actualizar la contraseña si se proporciona
        }
        const reactivatedUser = await this.usersRepository.save(existingUser);

        await this.notificationsService.sendWelcomeEmail(
          reactivatedUser.email,
          reactivatedUser.name,
        );

        const {
          password: _,
          isAdmin,
          ...userWithoutPassword
        } = reactivatedUser;
        return userWithoutPassword;
      } else {
        // Si el usuario ya está activo, lanzar un error
        throw new BadRequestException('user already registered');
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await this.usersRepository.save({
      ...userWithoutConfirmation,
      password: hashedPassword,
      email: email,
      isAdmin: false,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: subscription.id, // Guardamos el ID de la suscripción de Stripe
      profileImage:
        'https://res.cloudinary.com/dixcrmeue/image/upload/v1743014544/xTREME_GYM_1_ivgi8t.png',
      subscriptionType: 'free',
      isActive: true,
    });

    await this.notificationsService.sendWelcomeEmail(
      newUser.email,
      newUser.name,
    );

    const { password: _, isAdmin, ...userWithoutPassword } = newUser;
    return userWithoutPassword;
  }

  async signIn(credentials: LoginUserDto) {
    const { email, password } = credentials;

    const finduser = await this.usersRepository.findOneBy({ email });
    if (!finduser) throw new BadRequestException('bad credentials');

    const passwordMatch = await bcrypt.compare(password, finduser.password);
    if (!passwordMatch) throw new BadRequestException('bad credentials');

    if (!finduser.isActive) {
      throw new BadRequestException('Usuario inactivo');
    }

    const user = await this.usersService.findProfile(finduser.id);

    if (!user) {
      throw new BadRequestException('Usuario no encontrado');
    }
    const userPayload = {
      id: finduser.id,
      email: finduser.email,
      isAdmin: finduser.isAdmin,
    };
    const token = this.jwtService.sign(userPayload);
    const { password: _, ...userWithoutPassword } = finduser;
    return {
      token,
      user: userWithoutPassword,
      message: 'Success',
    };
  }

  // perfiles de inicio de sesion por terceros

  private generateJwt(user: User): string {
    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      provider: user.provider,
      isAdmin: user.isAdmin,
    };

    return this.jwtService.sign(payload, {
      expiresIn: '7d', // Puedes poner '1h', '24h', '30d', etc. según prefieras
    });
  }

  async validateOAuthLogin(
    profile: any,
    provider: string,
  ): Promise<{ user: User; accessToken: string }> {
   

     const getAdminEmails = (): string[] => {
       const admins = process.env.ADMIN_EMAILS;
       if (!admins) {
         console.warn(
           'ADMIN_EMAILS no está definido en .env - Usando valor por defecto',
         );
         return ['admin@tudominio.com']; // Email admin por defecto  // aca va el admin por defecto que sera el que se use para el login
       }
       return admins.split(',').map((email) => email.trim());
     };

     // 2. Buscar usuario
     const user = await this.usersRepository.findOne({
       where: { email: profile.email },
       relations: ['accounts'],
     });

     // 3. Verificar admin (con validación segura)
     const adminEmails = getAdminEmails();
     const shouldBeAdmin = adminEmails.includes(profile.email);

    // 2. Si el usuario existe
    if (user) {
      // Verificar si ya tiene esta cuenta vinculada
      const accountExists = user.accounts.some(
        (acc) =>
          acc.provider === provider && acc.providerAccountId === profile.sub,
      );

      if (!accountExists) {
        const newAccount = this.accountRepository.create({
          type: 'oauth',
          provider,
          providerAccountId: profile.sub,
          access_token: profile.accessToken,
          expires_at: profile.expires_in,
          token_type: profile.token_type,
          scope: profile.scope,
          user,
        });
        await this.accountRepository.save(newAccount);
      }

      // Actualizar datos del usuario
      const updatedUserData: Partial<User> = {
        provider,
        isAdmin: user.isAdmin || shouldBeAdmin, // Mantiene el estado admin si ya lo era
      };

      if (profile.picture) {
        updatedUserData.profileImage = profile.picture;
      }

      await this.usersRepository.update(user.id, updatedUserData);
      const updatedUser = { ...user, ...updatedUserData };

      // Generar JWT
      const accessToken = this.generateJwt(updatedUser);
      return { user: updatedUser, accessToken };
    }

    // 3. Si el usuario no existe, crearlo con Stripe
    // ✅ Crear cliente en Stripe
    const customer = await this.stripeService.createCustomer(profile.email);

    // ✅ Crear suscripción gratuita
    const freePlanId = 'price_1R9Imk2LBi4exdRbWcRfF1Go';
    const subscription = await this.stripeService.createSubscription(
      customer.id,
      freePlanId,
    );

    const newUser = this.usersRepository.create({
      email: profile.email,
      name: profile.name || profile.email.split('@')[0],
      password: await bcrypt.hash(Math.random().toString(36).slice(-10), 10),
      provider,
      isActive: true,
      isAdmin: shouldBeAdmin,
      profileImage: profile.picture,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: subscription.id,
      subscriptionType: 'free',
    });

    const savedUser = await this.usersRepository.save(newUser);

    // Crear cuenta OAuth asociada
    const newAccount = this.accountRepository.create({
      type: 'oauth',
      provider,
      providerAccountId: profile.sub,
      access_token: profile.accessToken,
      expires_at: profile.expires_in,
      token_type: profile.token_type,
      scope: profile.scope,
      user: savedUser,
    });
    await this.accountRepository.save(newAccount);

    // Enviar email de bienvenida
    await this.notificationsService.sendWelcomeEmail(
      savedUser.email,
      savedUser.name,
    );

    // Generar JWT
    const accessToken = this.generateJwt(savedUser);
    return { user: savedUser, accessToken };
  }
}
