package com.acme.users;

public final class UserMapper {
  private UserMapper() {}
  public static UserDto toDto(UserEntity e) { return new UserDto(); }
  public static UserEntity toEntity(UserDto d) { return new UserEntity(); }
}
