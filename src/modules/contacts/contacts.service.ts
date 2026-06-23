import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContactQueryDto, CreateContactDto } from './dto/contact.dto';
import { Prisma } from '@generated/prisma';

interface ContactRow {
  id: string;
  name: string;
  username: string;
  origin: string;
  keywordUsed: string | null;
  automationName: string | null;
  firstInteractionAt: Date;
  lastInteractionAt: Date;
  contactTags: { tag: { name: string } }[];
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  private shape(c: ContactRow) {
    const { contactTags, ...rest } = c;
    return { ...rest, tags: contactTags.map((ct) => ct.tag.name) };
  }

  async list(userId: string, query: ContactQueryDto) {
    const where: Prisma.ContactWhereInput = { userId };
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { username: { contains: query.q, mode: 'insensitive' } },
        { keywordUsed: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.tag) {
      where.contactTags = { some: { tag: { name: query.tag } } };
    }

    const contacts = await this.prisma.contact.findMany({
      where,
      include: { contactTags: { include: { tag: true } } },
      orderBy: { lastInteractionAt: 'desc' },
    });
    return contacts.map((c) => this.shape(c));
  }

  async tags(userId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
    return tags.map((t) => t.name);
  }

  async create(userId: string, dto: CreateContactDto) {
    const contact = await this.prisma.contact.upsert({
      where: { userId_username: { userId, username: dto.username } },
      create: {
        userId,
        name: dto.name,
        username: dto.username,
        origin: dto.origin,
        keywordUsed: dto.keywordUsed,
        automationName: dto.automationName,
      },
      update: { lastInteractionAt: new Date() },
      include: { contactTags: { include: { tag: true } } },
    });

    if (dto.tags?.length) {
      await this.applyTags(userId, contact.id, dto.tags);
    }

    return this.get(userId, contact.id);
  }

  /** Garante as tags do usuário e as associa ao contato. */
  async applyTags(userId: string, contactId: string, tagNames: string[]) {
    for (const name of tagNames) {
      const tag = await this.prisma.tag.upsert({
        where: { userId_name: { userId, name } },
        create: { userId, name },
        update: {},
      });
      await this.prisma.contactTag.upsert({
        where: { contactId_tagId: { contactId, tagId: tag.id } },
        create: { contactId, tagId: tag.id },
        update: {},
      });
    }
  }

  async get(userId: string, id: string) {
    const contact = await this.prisma.contact.findFirstOrThrow({
      where: { id, userId },
      include: { contactTags: { include: { tag: true } } },
    });
    return this.shape(contact);
  }
}
