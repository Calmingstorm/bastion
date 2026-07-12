package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("password stored in plaintext")
	}

	ok, err := VerifyPassword(hash, "correct horse battery staple")
	if err != nil || !ok {
		t.Fatalf("VerifyPassword(correct): ok=%v err=%v", ok, err)
	}

	ok, err = VerifyPassword(hash, "wrong password")
	if err != nil {
		t.Fatalf("VerifyPassword(wrong) error: %v", err)
	}
	if ok {
		t.Fatal("VerifyPassword accepted the wrong password")
	}
}

func TestAccessTokenRoundTrip(t *testing.T) {
	secret := "unit-test-secret"
	userID := uuid.New()

	tok, err := GenerateAccessToken(userID, secret, time.Minute)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}
	claims, err := ValidateToken(tok, secret)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.Subject != userID.String() {
		t.Fatalf("subject = %q, want %q", claims.Subject, userID.String())
	}
	if claims.TokenType != "access" {
		t.Fatalf("token type = %q, want access", claims.TokenType)
	}
}

func TestRefreshTokenTypeIsRefresh(t *testing.T) {
	secret := "unit-test-secret"
	tok, err := GenerateRefreshToken(uuid.New(), secret, time.Hour)
	if err != nil {
		t.Fatalf("GenerateRefreshToken: %v", err)
	}
	claims, err := ValidateToken(tok, secret)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.TokenType != "refresh" {
		t.Fatalf("token type = %q, want refresh", claims.TokenType)
	}
}

func TestValidateTokenRejectsWrongSecret(t *testing.T) {
	tok, err := GenerateAccessToken(uuid.New(), "secret-a", time.Minute)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}
	if _, err := ValidateToken(tok, "secret-b"); err == nil {
		t.Fatal("ValidateToken accepted a token signed with a different secret")
	}
}

func TestValidateTokenRejectsExpired(t *testing.T) {
	secret := "unit-test-secret"
	tok, err := GenerateAccessToken(uuid.New(), secret, -time.Minute) // already expired
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}
	if _, err := ValidateToken(tok, secret); err == nil {
		t.Fatal("ValidateToken accepted an expired token")
	}
}

// TestValidateTokenRejectsNoneAlg guards against the classic alg:none bypass.
func TestValidateTokenRejectsNoneAlg(t *testing.T) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: uuid.New().String()},
		TokenType:        "access",
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	signed, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none-alg token: %v", err)
	}
	if _, err := ValidateToken(signed, "any-secret"); err == nil {
		t.Fatal("ValidateToken accepted an alg:none token")
	}
}
